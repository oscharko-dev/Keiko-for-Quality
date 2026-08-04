import { createHash } from "node:crypto";
import { chmod, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

import type { sha256 } from "../core/brands.js";
import type { Diagnostics } from "../diagnostics/sink.js";
import {
  ENGINE_PIN,
  assetUrl,
  platformKey,
  type EnginePin,
  type PlatformPin,
} from "./pinned-release.js";

export class AcquisitionError extends Error {
  public readonly reason:
    | "engine.acquire.unsupported_platform"
    | "engine.acquire.download_failed"
    | "engine.acquire.digest_mismatch";

  public constructor(reason: AcquisitionError["reason"]) {
    super(reason);
    this.name = "AcquisitionError";
    this.reason = reason;
  }
}

/** 256 MiB. Far above any plausible engine binary, far below a memory-exhaustion payload. */
const MAX_BINARY_BYTES = 256 * 1024 * 1024;

function reportDownloadFailed(diagnostics: Diagnostics, version: EnginePin["version"]): never {
  diagnostics.record("engine.acquire.download_failed", { version });
  throw new AcquisitionError("engine.acquire.download_failed");
}

/**
 * Reads `response.body` as a stream, cancelling as soon as the accumulated size crosses
 * `MAX_BINARY_BYTES` — enforced against bytes actually received, not the declared `content-length`
 * this function's caller already rejects as a cheap fast path. `content-length` is trustworthy only
 * when the server sends an honest one; an absent header (0, the fast path's own fallback) or an
 * understated one would otherwise let `download`'s old post-hoc check buffer an unbounded response
 * in full before ever measuring it. `response.body === null` (a response with no body at all, e.g.
 * certain redirects or a 204) degrades to the same download-failed outcome as any other malformed
 * response, via the caller's own `reader === undefined` check.
 */
async function readBounded(response: Response): Promise<Buffer | undefined> {
  const reader = response.body?.getReader();
  if (reader === undefined) return undefined;
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > MAX_BINARY_BYTES) {
        await reader.cancel();
        return undefined;
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks);
}

async function download(
  url: string,
  diagnostics: Diagnostics,
  version: EnginePin["version"],
): Promise<Buffer> {
  const response = await fetch(url, { redirect: "follow" });
  if (!response.ok) reportDownloadFailed(diagnostics, version);
  const declared = Number(response.headers.get("content-length") ?? "0");
  if (declared > MAX_BINARY_BYTES) reportDownloadFailed(diagnostics, version);
  const bytes = await readBounded(response);
  if (bytes === undefined || bytes.byteLength === 0) {
    reportDownloadFailed(diagnostics, version);
  }
  return bytes;
}

export function digestOf(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

export interface AcquiredEngine {
  readonly binaryPath: string;
  readonly digest: ReturnType<typeof sha256>;
}

/**
 * Where a previously downloaded engine binary might already be sitting on disk, keyed so a stale
 * version or a different platform's asset can never collide with this run's own lookup.
 *
 * `RUNNER_TOOL_CACHE` is checked first because it is GitHub Actions' own tool-cache root — the value
 * the product's actual deployment target sets, and (unlike a hand-rolled temp directory) one that
 * can persist across jobs. `XDG_CACHE_HOME`, then `~/.cache`, are the same fallback order every other
 * well-behaved CLI on Linux/macOS already uses, so a local `npm run review` or a non-Actions CI still
 * gets a durable cache location instead of none at all.
 */
function cacheRoot(env: NodeJS.ProcessEnv): string {
  const runnerToolCache = env.RUNNER_TOOL_CACHE;
  if (runnerToolCache !== undefined && runnerToolCache.length > 0) return runnerToolCache;
  const xdgCacheHome = env.XDG_CACHE_HOME;
  if (xdgCacheHome !== undefined && xdgCacheHome.length > 0) return xdgCacheHome;
  return join(homedir(), ".cache");
}

/** The one deterministic path a given pinned platform asset always lives at. */
function cacheFilePath(env: NodeJS.ProcessEnv, pin: EnginePin, target: PlatformPin): string {
  return join(cacheRoot(env), "keiko-for-quality", "engine", pin.version, target.asset);
}

/**
 * Reads a cached copy and returns it only if it is byte-for-byte the pin this run requires.
 *
 * Any read failure — no cache yet, a permissions problem, a directory where a file was expected — is
 * treated identically to "no cache": this is a pure optimization, so the only two outcomes that may
 * ever reach the caller are "here are verified bytes" and "go download it," never a throw.
 *
 * A digest MISMATCH is different from a plain absence: the file is real but wrong, so it is deleted
 * before returning `undefined` rather than left for a later run to trip over — the same fail-closed
 * posture the download path already has (no digest match, no execution), extended so a corrupted
 * cache entry cannot even sit on disk to confuse the next run's own lookup. The deletion itself is
 * best-effort: an entry this process cannot remove still can never be *used*, because this same check
 * rejects it again next time, so the worst case is a repeated download, never a bad execution.
 */
async function readCachedIfValid(
  cachedPath: string,
  target: PlatformPin,
): Promise<Buffer | undefined> {
  let cached: Buffer;
  try {
    cached = await readFile(cachedPath);
  } catch {
    return undefined;
  }
  if (digestOf(cached) === (target.sha256 as string)) return cached;
  await rm(cachedPath, { force: true }).catch(() => undefined);
  return undefined;
}

/**
 * Writes a freshly verified download back to the cache location so a later run can skip its own
 * download. Best effort and silent on failure: a read-only or missing-parent cache root must never
 * fail a run over an optimization that only ever pays off on a LATER run — the workspace copy
 * `acquireEngine` writes separately is the one this run actually executes, unaffected either way.
 * Written without the execute bit: nothing ever runs this copy in place, only the workspace one
 * (`acquireEngine`'s own `chmod 0o700`) is ever handed to the engine runner.
 */
async function populateCache(cachedPath: string, bytes: Buffer): Promise<void> {
  try {
    await mkdir(dirname(cachedPath), { recursive: true, mode: 0o700 });
    await writeFile(cachedPath, bytes, { mode: 0o600 });
  } catch {
    // Swallowed by design — see doc comment above.
  }
}

/**
 * Produces byte-verified engine bytes: from the local cache when a valid copy is there, from a
 * fresh, digest-checked download otherwise. Never returns bytes that have not been proven to match
 * `target.sha256` — a cache hit is pre-verified by `readCachedIfValid`, and a download is verified
 * here exactly as it always was, mismatch and all.
 */
async function acquireVerifiedBytes(
  cachedPath: string,
  pin: EnginePin,
  target: PlatformPin,
  diagnostics: Diagnostics,
): Promise<{ readonly bytes: Buffer; readonly cacheHit: boolean }> {
  const cached = await readCachedIfValid(cachedPath, target);
  if (cached !== undefined) return { bytes: cached, cacheHit: true };

  const bytes = await download(assetUrl(pin, target.asset), diagnostics, pin.version);
  const actual = digestOf(bytes);
  if (actual !== (target.sha256 as string)) {
    diagnostics.record("engine.acquire.digest_mismatch", {
      version: pin.version,
      digest: target.sha256,
    });
    throw new AcquisitionError("engine.acquire.digest_mismatch");
  }
  return { bytes, cacheHit: false };
}

/**
 * Acquires the pinned engine and proves it is the artifact we qualified — from a local cache when
 * possible, downloading it when not.
 *
 * The digest is compared before the file is ever made executable, cache hit or fresh download alike.
 * A download whose bytes do not match is terminal: there is no second attempt and no alternative
 * asset, because the only situations that produce one are a corrupted transfer, a moved upstream tag,
 * or a substituted artifact — and none of those should end with this process running the result. A
 * CACHED copy that does not match is not terminal — see `readCachedIfValid` — because unlike a
 * download it has an obvious, safe fallback: the exact download path this function has always had.
 *
 * `env` defaults to the real `process.env` rather than being threaded in from the call site the way
 * `config/runtime.ts`'s `readModelToken` requires its own `env` parameter. That stricter pattern
 * exists for a *secret* — a token env var name resolves to a value that must never be defaulted out
 * of a caller's control. Nothing here is a secret: `RUNNER_TOOL_CACHE`/`XDG_CACHE_HOME` only ever
 * pick a directory to look in, before an unconditional sha256 check decides whether anything found
 * there may be trusted — the same gate a downloaded artifact must always pass. Defaulting it here,
 * the same treatment already given `platform`/`arch` below, is what keeps this a pure optimization
 * added entirely inside this module: the existing call site (`review.ts`) keeps compiling and keeps
 * its current behaviour unchanged, and a test can still inject a fake `env` to make cache placement
 * deterministic.
 */
export async function acquireEngine(
  directory: string,
  diagnostics: Diagnostics,
  pin: EnginePin = ENGINE_PIN,
  platform: NodeJS.Platform = process.platform,
  arch: string = process.arch,
  env: NodeJS.ProcessEnv = process.env,
): Promise<AcquiredEngine> {
  const key = platformKey(platform, arch);
  const target = pin.platforms[key];
  if (target === undefined) {
    diagnostics.record("engine.acquire.unsupported_platform", { version: pin.version });
    throw new AcquisitionError("engine.acquire.unsupported_platform");
  }

  const started = Date.now();
  const cachedPath = cacheFilePath(env, pin, target);
  const { bytes, cacheHit } = await acquireVerifiedBytes(cachedPath, pin, target, diagnostics);

  await mkdir(directory, { recursive: true, mode: 0o700 });
  const binaryPath = join(directory, "opencodereview");
  await writeFile(binaryPath, bytes, { mode: 0o700 });
  await chmod(binaryPath, 0o700);

  // Only a freshly downloaded copy needs writing back — a cache hit's bytes came from this exact
  // file already.
  if (!cacheHit) await populateCache(cachedPath, bytes);

  diagnostics.record("engine.acquire.verified", {
    version: pin.version,
    digest: target.sha256,
    durationMs: Date.now() - started,
    // `cache_hit` is a 0/1 flag riding the same bounded-numeric-context field every other count
    // uses (`DiagnosticFields.counts`) rather than a new reason code: it answers "did the ~45 MB
    // transfer happen," which is the one thing an operator reading this record cannot infer from
    // `durationMs` alone on a fast local network.
    counts: { bytes: bytes.byteLength, cache_hit: cacheHit ? 1 : 0 },
  });

  return { binaryPath, digest: target.sha256 };
}
