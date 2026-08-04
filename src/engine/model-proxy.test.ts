import { createServer, type Server } from "node:http";

import { afterEach, describe, expect, it } from "vitest";

import { startModelProxy, type ModelProxy } from "./model-proxy.js";

interface CapturedRequest {
  readonly path: string;
  readonly method: string;
  readonly authorization: string | undefined;
  readonly body: string;
}

interface UpstreamReply {
  readonly status: number;
  readonly contentType: string;
  readonly body: string;
}

const DEFAULT_REPLY: UpstreamReply = {
  status: 200,
  contentType: "application/json",
  body: '{"ok":true}',
};

/**
 * Hermetic loopback upstream: captures what arrives and answers a fixed body by default, or —
 * when a test passes `respond` — whatever that test wants for each request in turn. The usage-
 * telemetry tests below use `respond` to script the exact response shapes (JSON usage, SSE,
 * malformed JSON) the proxy has to tolerate without ever letting them interfere with forwarding.
 */
function startUpstream(
  respond: (requestBody: string) => UpstreamReply = () => DEFAULT_REPLY,
): Promise<{
  url: string;
  captured: CapturedRequest[];
  close: () => Promise<void>;
}> {
  const captured: CapturedRequest[] = [];
  const server: Server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      const body = Buffer.concat(chunks).toString("utf8");
      captured.push({
        path: request.url ?? "/",
        method: request.method ?? "",
        authorization:
          typeof request.headers.authorization === "string"
            ? request.headers.authorization
            : undefined,
        body,
      });
      const reply = respond(body);
      response.writeHead(reply.status, { "content-type": reply.contentType });
      response.end(reply.body);
    });
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (address === null || typeof address === "string") throw new Error("no address");
      resolve({
        url: `http://127.0.0.1:${String(address.port)}`,
        captured,
        close: () =>
          new Promise<void>((done) => {
            server.close(() => {
              done();
            });
          }),
      });
    });
  });
}

describe("startModelProxy", () => {
  const cleanups: (() => Promise<void>)[] = [];
  afterEach(async () => {
    while (cleanups.length > 0) await cleanups.pop()?.();
  });

  async function proxied(temperature: number): Promise<{
    proxy: ModelProxy;
    captured: CapturedRequest[];
  }> {
    const upstream = await startUpstream();
    cleanups.push(upstream.close);
    const proxy = await startModelProxy({ upstreamUrl: upstream.url, temperature, seed: 42 });
    cleanups.push(() => proxy.close());
    return { proxy, captured: upstream.captured };
  }

  it("overwrites the temperature on a chat-completions body and forwards the token header", async () => {
    const { proxy, captured } = await proxied(0);
    const response = await fetch(`${proxy.url}/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer secret" },
      body: JSON.stringify({ model: "m", temperature: 1, messages: [] }),
    });
    expect(response.status).toBe(200);
    expect(captured).toHaveLength(1);
    const body = JSON.parse(captured[0]?.body ?? "{}") as {
      temperature?: number;
      model?: string;
      seed?: number;
    };
    expect(body.temperature).toBe(0);
    expect(body.seed).toBe(42);
    expect(body.model).toBe("m");
    expect(captured[0]?.authorization).toBe("Bearer secret");
  });

  it("adds the temperature when the engine sent none", async () => {
    const { proxy, captured } = await proxied(0);
    await fetch(`${proxy.url}/openai/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "m", messages: [] }),
    });
    const body = JSON.parse(captured[0]?.body ?? "{}") as { temperature?: number };
    expect(body.temperature).toBe(0);
  });

  it("passes non-chat paths and non-JSON bodies through byte-identical", async () => {
    const { proxy, captured } = await proxied(0);
    await fetch(`${proxy.url}/models`, {
      method: "POST",
      headers: { "content-type": "text/plain" },
      body: "raw payload",
    });
    await fetch(`${proxy.url}/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "not json",
    });
    expect(captured[0]?.body).toBe("raw payload");
    expect(captured[1]?.body).toBe("not json");
  });

  it("answers 502 with an upstream-shaped error when the upstream is unreachable", async () => {
    const proxy = await startModelProxy({
      upstreamUrl: "http://127.0.0.1:1",
      temperature: 0,
      seed: 42,
    });
    cleanups.push(() => proxy.close());
    const response = await fetch(`${proxy.url}/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    expect(response.status).toBe(502);
  });

  describe("usage()", () => {
    async function withUpstream(
      respond: (requestBody: string) => UpstreamReply,
    ): Promise<{ proxy: ModelProxy; captured: CapturedRequest[] }> {
      const upstream = await startUpstream(respond);
      cleanups.push(upstream.close);
      const proxy = await startModelProxy({ upstreamUrl: upstream.url, temperature: 0, seed: 42 });
      cleanups.push(() => proxy.close());
      return { proxy, captured: upstream.captured };
    }

    it("reports all-zero usage before any request is forwarded", async () => {
      const { proxy } = await proxied(0);
      expect(proxy.usage()).toEqual({ requests: 0, prompt: 0, completion: 0, cached: 0 });
    });

    it("accumulates prompt, completion, and request counts across multiple JSON responses", async () => {
      const bodies = [
        JSON.stringify({ usage: { prompt_tokens: 10, completion_tokens: 5 } }),
        JSON.stringify({ usage: { prompt_tokens: 7, completion_tokens: 3 } }),
      ];
      let call = 0;
      const { proxy, captured } = await withUpstream(() => {
        const body = bodies[call] ?? "{}";
        call += 1;
        return { status: 200, contentType: "application/json", body };
      });
      const send = (): Promise<Response> =>
        fetch(`${proxy.url}/chat/completions`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ model: "m", messages: [] }),
        });

      await send();
      await send();

      expect(captured).toHaveLength(2);
      expect(proxy.usage()).toEqual({ requests: 2, prompt: 17, completion: 8, cached: 0 });
    });

    it("reads cached_tokens from usage.prompt_tokens_details", async () => {
      const { proxy } = await withUpstream(() => ({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          usage: {
            prompt_tokens: 100,
            completion_tokens: 20,
            prompt_tokens_details: { cached_tokens: 64 },
          },
        }),
      }));

      await fetch(`${proxy.url}/chat/completions`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model: "m", messages: [] }),
      });

      expect(proxy.usage()).toEqual({ requests: 1, prompt: 100, completion: 20, cached: 64 });
    });

    it("tolerates a response with no usage field, then one with usage but no cache details", async () => {
      const bodies = [
        '{"ok":true}',
        JSON.stringify({ usage: { prompt_tokens: 5, completion_tokens: 2 } }),
      ];
      let call = 0;
      const { proxy } = await withUpstream(() => {
        const body = bodies[call] ?? "{}";
        call += 1;
        return { status: 200, contentType: "application/json", body };
      });
      const send = (): Promise<Response> =>
        fetch(`${proxy.url}/chat/completions`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: "{}",
        });

      await send();
      await send();

      // First response had no `usage` at all; second had `usage` but no `prompt_tokens_details`.
      // Neither missing piece should cost the fields that were actually present.
      expect(proxy.usage()).toEqual({ requests: 2, prompt: 5, completion: 2, cached: 0 });
    });

    it("counts an SSE chat-completions response as a request without adding token fields", async () => {
      const { proxy, captured } = await withUpstream(() => ({
        status: 200,
        contentType: "text/event-stream",
        body: 'data: {"usage":{"prompt_tokens":999,"completion_tokens":999}}\n\n',
      }));

      const response = await fetch(`${proxy.url}/chat/completions`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model: "m", messages: [], stream: true }),
      });

      // The body above is deliberately usage-shaped text: proving it is never parsed is the point
      // of this test — only the content-type gate decides whether accounting even looks at it.
      expect(response.headers.get("content-type")).toBe("text/event-stream");
      expect(captured).toHaveLength(1);
      expect(proxy.usage()).toEqual({ requests: 1, prompt: 0, completion: 0, cached: 0 });
    });

    it("counts a malformed JSON chat-completions body as a request without adding token fields", async () => {
      const { proxy } = await withUpstream(() => ({
        status: 200,
        contentType: "application/json",
        body: "not json",
      }));

      const response = await fetch(`${proxy.url}/chat/completions`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model: "m", messages: [] }),
      });

      expect(response.status).toBe(200);
      expect(proxy.usage()).toEqual({ requests: 1, prompt: 0, completion: 0, cached: 0 });
    });

    it("does not count a non-chat-completions path even with a usage-shaped JSON body", async () => {
      const { proxy, captured } = await withUpstream(() => ({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ usage: { prompt_tokens: 5, completion_tokens: 5 } }),
      }));

      await fetch(`${proxy.url}/models`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}",
      });

      expect(captured).toHaveLength(1);
      expect(proxy.usage()).toEqual({ requests: 0, prompt: 0, completion: 0, cached: 0 });
    });
  });
});
