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
 *
 * Also accumulates wire-level usage telemetry across every request it forwards: a count of
 * chat-completions requests, plus prompt/completion/cached token totals read from each JSON
 * response. This exists because the engine's own self-report is not proof of what the wire
 * actually carried, and provider prompt-cache behaviour (the `cached` figure) is not visible
 * anywhere else in this pipeline. The accounting reads only the body already buffered for
 * forwarding, so it costs no extra I/O, and — unlike the reject-on-mismatch posture the rest of
 * this product takes at a trust boundary — a shape it does not recognise contributes zero rather
 * than interrupting the forward: this is observational telemetry, never a gate.
 */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";

/** Wire-observed totals. Counts only — see the module doc for why this exists. */
export interface ModelUsage {
  /** Forwarded requests whose normalized path ended `/chat/completions`. */
  readonly requests: number;
  readonly prompt: number;
  readonly completion: number;
  /** Provider-reported `usage.prompt_tokens_details.cached_tokens`, summed. */
  readonly cached: number;
}

export interface ModelProxy {
  /** `http://127.0.0.1:<port>` — hand this to the engine as its model endpoint. */
  readonly url: string;
  close(): Promise<void>;
  /**
   * A snapshot of usage across every request forwarded so far — not a live view, so a caller that
   * holds on to the returned object is unaffected by requests the proxy handles afterward.
   */
  usage(): ModelUsage;
}

export interface ModelProxyOptions {
  /** The real endpoint, e.g. `https://host/openai/v1`. */
  readonly upstreamUrl: string;
  /** Applied to every chat-completions body, overwriting whatever the engine sent. */
  readonly temperature: number;
  /**
   * Sampling seed, pinned for the same reason as the temperature — measured on Azure gpt-oss-120b
   * (2026-08-04): temperature 0 alone still diverged between identical requests (MoE/batching
   * noise), while an explicit seed produced byte-identical completions three out of three.
   */
  readonly seed: number;
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
 * Pathname only: Azure-style deployments append query strings (`?api-version=...`), and a
 * query-carrying URL must not silently disable the determinism pin — or, for the same reason,
 * silently drop a request from the usage count below, which relies on this identical check.
 */
function isChatCompletionsPath(path: string): boolean {
  const pathname = path.split("?")[0] ?? path;
  return pathname.endsWith("/chat/completions");
}

/**
 * Overwrites the sampling parameters when the body is a chat-completions JSON object; anything
 * else — other endpoints, malformed bodies — passes through byte-identical. Overwrite, not
 * default: the point is that the pinned value wins over whatever the engine chose.
 */
function pinSampling(path: string, body: Buffer, options: ModelProxyOptions): Buffer {
  if (!isChatCompletionsPath(path)) return body;
  try {
    const parsed: unknown = JSON.parse(body.toString("utf8"));
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return body;
    return Buffer.from(
      JSON.stringify({ ...parsed, temperature: options.temperature, seed: options.seed }),
      "utf8",
    );
  } catch {
    return body;
  }
}

/** Mutated in place as requests are forwarded; every external view is the readonly snapshot above. */
interface MutableUsage {
  requests: number;
  prompt: number;
  completion: number;
  cached: number;
}

function isJsonContentType(contentType: string | null): boolean {
  return contentType?.toLowerCase().includes("application/json") ?? false;
}

/**
 * A finite number at `container[key]`, or 0.
 *
 * Never throws: this is telemetry, not a trust boundary, and one malformed field must not cost the
 * others their count. `Array.isArray` is excluded the same way `asObject` excludes it elsewhere in
 * this product — an array has typeof "object" but no field of this name worth reading.
 */
function numericField(container: unknown, key: string): number {
  if (typeof container !== "object" || container === null || Array.isArray(container)) return 0;
  const value = (container as Record<string, unknown>)[key];
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

/** The object at `container[key]`, or `undefined`. Same non-throwing contract as `numericField`. */
function objectField(container: unknown, key: string): unknown {
  if (typeof container !== "object" || container === null || Array.isArray(container)) {
    return undefined;
  }
  return (container as Record<string, unknown>)[key];
}

/**
 * Adds one upstream JSON response's token usage into the running total.
 *
 * Each field is read independently so a response carrying `usage` but no `prompt_tokens_details`
 * (no cache reporting) still contributes its prompt/completion counts instead of losing all three
 * to one missing nested object — "each absent/malformed field contributes 0" is a per-field
 * contract, not an all-or-nothing one.
 */
function accumulateUsage(usage: MutableUsage, body: Buffer): void {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body.toString("utf8"));
  } catch {
    return;
  }
  const usageField = objectField(parsed, "usage");
  usage.prompt += numericField(usageField, "prompt_tokens");
  usage.completion += numericField(usageField, "completion_tokens");
  usage.cached += numericField(objectField(usageField, "prompt_tokens_details"), "cached_tokens");
}

/**
 * The two usage-counting call sites, split out of `forward` itself so its own branching stays
 * readable rather than tripping the file's complexity ceiling — the decisions here are simple
 * enough that moving them costs nothing but the function-call indirection.
 */
function countRequest(usage: MutableUsage, isChatCompletions: boolean): void {
  if (isChatCompletions) usage.requests += 1;
}

function countResponse(
  usage: MutableUsage,
  isChatCompletions: boolean,
  contentType: string | null,
  body: Buffer,
): void {
  if (isChatCompletions && isJsonContentType(contentType)) accumulateUsage(usage, body);
}

async function forward(
  options: ModelProxyOptions,
  request: IncomingMessage,
  response: ServerResponse,
  usage: MutableUsage,
): Promise<void> {
  const doFetch = options.fetchImpl ?? fetch;
  try {
    const body = await readBody(request);
    const path = request.url ?? "/";
    const method = request.method ?? "POST";
    const withBody = method !== "GET" && method !== "HEAD";
    // Counted at forward time, independent of what the upstream does with it: this is "did the
    // engine make the call", not "did the call succeed" — the 502 branch below still means the
    // engine paid for the round trip in wall-clock time even though no tokens come back.
    const isChatCompletions = isChatCompletionsPath(path);
    countRequest(usage, isChatCompletions);
    const upstream = await doFetch(`${options.upstreamUrl.replace(/\/+$/, "")}${path}`, {
      method,
      headers: upstreamHeaders(request),
      ...(withBody ? { body: new Uint8Array(pinSampling(path, body, options)) } : {}),
    });
    const contentType = upstream.headers.get("content-type");
    response.writeHead(upstream.status, { "content-type": contentType ?? "application/json" });
    const responseBody = Buffer.from(await upstream.arrayBuffer());
    // Reads the body already buffered for the forward above — no extra I/O, and nothing here can
    // delay or fail the response: an SSE or other non-JSON body still counted as a request above,
    // it just carries no token fields to add.
    countResponse(usage, isChatCompletions, contentType, responseBody);
    response.end(responseBody);
  } catch {
    // A transport failure becomes an upstream-shaped error the engine already knows how to
    // handle and retry; the error VALUE is dropped so nothing about the upstream leaks into
    // whatever the engine logs. The write itself is guarded: if the engine's own timeout already
    // destroyed the socket, writing would throw, the rejection would escape `void forward(...)`,
    // and an unhandled rejection would take down the whole run — a model-call timeout must
    // surface as an engine error, never as a process death.
    try {
      if (!response.headersSent) {
        response.writeHead(502, { "content-type": "application/json" });
      }
      response.end('{"error":{"message":"upstream unreachable"}}');
    } catch {
      // Socket already gone; the engine has its failure either way.
    }
  }
}

export function startModelProxy(options: ModelProxyOptions): Promise<ModelProxy> {
  const usage: MutableUsage = { requests: 0, prompt: 0, completion: 0, cached: 0 };
  const server: Server = createServer((request, response) => {
    void forward(options, request, response, usage);
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
        usage: () => ({ ...usage }),
      });
    });
  });
}
