import { createServer, type Server } from "node:http";

import { afterEach, describe, expect, it } from "vitest";

import { startModelProxy, type ModelProxy } from "./model-proxy.js";

interface CapturedRequest {
  readonly path: string;
  readonly method: string;
  readonly authorization: string | undefined;
  readonly body: string;
}

/** Hermetic loopback upstream: captures what arrives and answers a fixed body. */
function startUpstream(): Promise<{
  url: string;
  captured: CapturedRequest[];
  close: () => Promise<void>;
}> {
  const captured: CapturedRequest[] = [];
  const server: Server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      captured.push({
        path: request.url ?? "/",
        method: request.method ?? "",
        authorization:
          typeof request.headers.authorization === "string"
            ? request.headers.authorization
            : undefined,
        body: Buffer.concat(chunks).toString("utf8"),
      });
      response.writeHead(200, { "content-type": "application/json" });
      response.end('{"ok":true}');
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
    const proxy = await startModelProxy({ upstreamUrl: upstream.url, temperature });
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
    const body = JSON.parse(captured[0]?.body ?? "{}") as { temperature?: number; model?: string };
    expect(body.temperature).toBe(0);
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
    });
    cleanups.push(() => proxy.close());
    const response = await fetch(`${proxy.url}/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    expect(response.status).toBe(502);
  });
});
