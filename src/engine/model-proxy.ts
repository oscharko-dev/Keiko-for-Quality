/**
 * A loopback proxy that pins sampling parameters on the engine's model calls.
 *
 * Why it exists: the engine exposes no temperature control — not as a flag, not as an environment
 * variable — and the serving stacks this reviewer must hold a bar on do not all enforce schemas or
 * sample deterministically by default. Measured across eight full corpus runs on gpt-oss-120b
 * (2026-08-03/04), per-case outcomes flipped run to run with the prompt byte-identical: recall
 * 21–23 of 24, a different set of cases each time. That is sampling variance, and no rule sentence
 * reduces it. A qualification bar of "everything, twice in a row" needs the one parameter every
 * OpenAI-compatible stack honors: `temperature`.
 *
 * Why a proxy rather than a fork of the engine: the engine is a digest-pinned upstream artifact —
 * this repository deliberately does not patch it. The proxy stays entirely inside the product
 * boundary: it listens on 127.0.0.1 only, exists for the lifetime of one engine invocation, and
 * rewrites exactly one thing — the sampling parameters of a chat-completions body. Credentials
 * pass through untouched in headers and are never read, logged, or stored; bodies are never
 * logged (the same redaction posture as the rest of this repository).
 *
 * Why it is import-free apart from node builtins: `corpus/run.mjs` loads this module directly
 * under Node's type stripping, so the corpus measures the identical pipeline the action ships —
 * the fixture-derives-from-the-producer rule, applied to ourselves.
 */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";

export interface ModelProxy {
  /** `http://127.0.0.1:<port>` — hand this to the engine as its model endpoint. */
  readonly url: string;
  close(): Promise<void>;
}

export interface ModelProxyOptions {
  /** The real endpoint, e.g. `https://host/openai/v1`. */
  readonly upstreamUrl: string;
  /** Applied to every chat-completions body, overwriting whatever the engine sent. */
  readonly temperature: number;
  readonly fetchImpl?: typeof fetch;
}

/** Headers worth forwarding; everything else is connection detail the upstream must not see. */
const FORWARDED_HEADERS = ["authorization", "api-key", "content-type", "accept"] as const;

function upstreamHeaders(request: IncomingMessage): Record<string, string> {
  const headers: Record<string, string> = {};
  for (const name of FORWARDED_HEADERS) {
    const value = request.headers[name];
    if (typeof value === "string") headers[name] = value;
  }
  return headers;
}

function readBody(request: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      resolve(Buffer.concat(chunks));
    });
    request.on("error", reject);
  });
}

/**
 * Overwrites the sampling parameters when the body is a chat-completions JSON object; anything
 * else — other endpoints, malformed bodies — passes through byte-identical. Overwrite, not
 * default: the point is that the pinned value wins over whatever the engine chose.
 */
function pinSampling(path: string, body: Buffer, temperature: number): Buffer {
  if (!path.endsWith("/chat/completions")) return body;
  try {
    const parsed: unknown = JSON.parse(body.toString("utf8"));
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return body;
    return Buffer.from(JSON.stringify({ ...parsed, temperature }), "utf8");
  } catch {
    return body;
  }
}

async function forward(
  options: ModelProxyOptions,
  request: IncomingMessage,
  response: ServerResponse,
): Promise<void> {
  const doFetch = options.fetchImpl ?? fetch;
  try {
    const body = await readBody(request);
    const path = request.url ?? "/";
    const method = request.method ?? "POST";
    const withBody = method !== "GET" && method !== "HEAD";
    const upstream = await doFetch(`${options.upstreamUrl.replace(/\/+$/, "")}${path}`, {
      method,
      headers: upstreamHeaders(request),
      ...(withBody ? { body: new Uint8Array(pinSampling(path, body, options.temperature)) } : {}),
    });
    response.writeHead(upstream.status, {
      "content-type": upstream.headers.get("content-type") ?? "application/json",
    });
    response.end(Buffer.from(await upstream.arrayBuffer()));
  } catch {
    // A transport failure becomes an upstream-shaped error the engine already knows how to
    // handle and retry; the error VALUE is dropped so nothing about the upstream leaks into
    // whatever the engine logs.
    response.writeHead(502, { "content-type": "application/json" });
    response.end('{"error":{"message":"upstream unreachable"}}');
  }
}

export function startModelProxy(options: ModelProxyOptions): Promise<ModelProxy> {
  const server: Server = createServer((request, response) => {
    void forward(options, request, response);
  });
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    // Loopback only, ephemeral port: nothing outside this machine can reach it, and two
    // concurrent runs cannot collide.
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (address === null || typeof address === "string") {
        server.close();
        reject(new Error("proxy address unavailable"));
        return;
      }
      resolve({
        url: `http://127.0.0.1:${String(address.port)}`,
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
