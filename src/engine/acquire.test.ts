import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { sha256, versionTag } from "../core/brands.js";
import { createSilentDiagnostics } from "../diagnostics/sink.js";
import type { EnginePin } from "./pinned-release.js";
import { AcquisitionError, acquireEngine, digestOf } from "./acquire.js";

/**
 * `acquireEngine`'s local cache layer (a named freeze-backlog gap: this file did not exist before —
 * `acquire.ts` had zero coverage). Exercised end to end against a real temporary filesystem and a
 * stubbed `globalThis.fetch` — the same stubbing shape `github/client.test.ts` uses (save the real
 * `fetch`, install a recording stub, restore it in `afterEach`) — rather than against the real
 * ~45 MB pinned binary or a real network call. Every "binary" below is a short, fabricated byte
 * string: nothing here is ever executed, only written to disk, read back, and digested.
 *
 * The fixture pin deliberately does not reuse `ENGINE_PIN` from `pinned-release.ts`: a fake, tiny
 * asset lets every test control its own digest and content without hand-hashing the real release,
 * and `platform`/`arch` are overridden to a fixed fake pair (the same technique
 * `pinned-release.test.ts` uses) so these tests behave identically regardless of which OS/arch
 * actually runs them.
 */

const PLATFORM: NodeJS.Platform = "linux";
const ARCH = "x64";
const ASSET = "fake-opencodereview-asset";
const VERSION = versionTag("v0.0.1-fixture");

const GOOD_BYTES = Buffer.from("fixture engine bytes -- never executed, only hashed and copied.");
const GOOD_DIGEST = sha256(digestOf(GOOD_BYTES));
// Real content, but not what the pin expects. Doubles as a stand-in for a stale/corrupted cache
// entry and for a tampered or wrong download — the mismatch check does not care which.
const WRONG_BYTES = Buffer.from("different fixture bytes that must never verify against the pin.");

const PIN: EnginePin = {
  engine: "example/fixture-engine",
  version: VERSION,
  platforms: {
    [`${PLATFORM}-${ARCH}`]: { asset: ASSET, sha256: GOOD_DIGEST },
  },
};

/** Mirrors the documented cache path shape: `<root>/keiko-for-quality/engine/<version>/<asset>`. */
function cachedAssetPath(cacheRoot: string): string {
  return join(cacheRoot, "keiko-for-quality", "engine", VERSION, ASSET);
}

function bytesResponse(bytes: Buffer, ok: boolean): Response {
  return new Response(bytes, {
    status: ok ? 200 : 500,
    headers: { "content-length": String(bytes.byteLength) },
  });
}

function urlOf(input: string | URL | Request): string {
  return typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
}

/** Records every fetched URL and answers every call with the same fixed bytes. */
function stubFetchReturning(bytes: Buffer, ok = true): string[] {
  const calls: string[] = [];
  globalThis.fetch = ((input: string | URL | Request) => {
    calls.push(urlOf(input));
    return Promise.resolve(bytesResponse(bytes, ok));
  }) as typeof fetch;
  return calls;
}

/** A fetch stub that fails loudly if it is ever invoked — for pinning "a cache hit skips fetch". */
function stubFetchForbidden(): string[] {
  const calls: string[] = [];
  globalThis.fetch = ((input: string | URL | Request) => {
    calls.push(urlOf(input));
    return Promise.reject(new Error("fetch must not be called on a cache hit"));
  }) as typeof fetch;
  return calls;
}

const originalFetch = globalThis.fetch;

let cacheRoot: string;
let workspace: string;

beforeEach(async () => {
  cacheRoot = await mkdtemp(join(tmpdir(), "kfq-acquire-cache-"));
  workspace = await mkdtemp(join(tmpdir(), "kfq-acquire-workspace-"));
});

afterEach(async () => {
  globalThis.fetch = originalFetch;
  await rm(cacheRoot, { recursive: true, force: true });
  await rm(workspace, { recursive: true, force: true });
});

describe("acquireEngine: cache hit", () => {
  it("uses a cached copy whose digest matches the pin without calling fetch, and writes a usable workspace binary", async () => {
    await mkdir(join(cacheRoot, "keiko-for-quality", "engine", VERSION), { recursive: true });
    await writeFile(cachedAssetPath(cacheRoot), GOOD_BYTES);

    const calls = stubFetchForbidden();
    const diagnostics = createSilentDiagnostics();
    const result = await acquireEngine(workspace, diagnostics, PIN, PLATFORM, ARCH, {
      RUNNER_TOOL_CACHE: cacheRoot,
    });

    expect(calls).toHaveLength(0);
    expect(result.digest).toBe(GOOD_DIGEST);
    const written = await readFile(result.binaryPath);
    expect(written.equals(GOOD_BYTES)).toBe(true);

    const verified = diagnostics.drain().find((r) => r.code === "engine.acquire.verified");
    expect(verified?.counts?.cache_hit).toBe(1);
  });
});

describe("acquireEngine: no local cache", () => {
  it("downloads, verifies, and populates the cache for a later run", async () => {
    const calls = stubFetchReturning(GOOD_BYTES);
    const diagnostics = createSilentDiagnostics();
    const result = await acquireEngine(workspace, diagnostics, PIN, PLATFORM, ARCH, {
      RUNNER_TOOL_CACHE: cacheRoot,
    });

    expect(calls).toHaveLength(1);
    expect(result.digest).toBe(GOOD_DIGEST);

    const cached = await readFile(cachedAssetPath(cacheRoot));
    expect(cached.equals(GOOD_BYTES)).toBe(true);

    const verified = diagnostics.drain().find((r) => r.code === "engine.acquire.verified");
    expect(verified?.counts?.cache_hit).toBe(0);
  });
});

describe("acquireEngine: cache present but digest-mismatched", () => {
  it("deletes the stale entry, falls through to a fresh download, and re-populates the cache", async () => {
    await mkdir(join(cacheRoot, "keiko-for-quality", "engine", VERSION), { recursive: true });
    await writeFile(cachedAssetPath(cacheRoot), WRONG_BYTES);

    const calls = stubFetchReturning(GOOD_BYTES);
    const result = await acquireEngine(workspace, createSilentDiagnostics(), PIN, PLATFORM, ARCH, {
      RUNNER_TOOL_CACHE: cacheRoot,
    });

    expect(calls).toHaveLength(1);
    expect(result.digest).toBe(GOOD_DIGEST);
    const cached = await readFile(cachedAssetPath(cacheRoot));
    expect(cached.equals(GOOD_BYTES)).toBe(true);
  });

  it("really deletes the stale entry rather than leaving it on disk: it is gone even when the redownload also fails", async () => {
    // Distinguishes "deleted, then possibly rewritten later" from "left alone and only ever
    // overwritten on success": if a fresh download fails, `populateCache` never runs at all, so the
    // only way this file can be gone afterward is that the mismatch handler itself removed it.
    await mkdir(join(cacheRoot, "keiko-for-quality", "engine", VERSION), { recursive: true });
    await writeFile(cachedAssetPath(cacheRoot), WRONG_BYTES);

    stubFetchReturning(GOOD_BYTES, false); // non-ok response -> download_failed, thrown pre-populate

    const diagnostics = createSilentDiagnostics();
    await expect(
      acquireEngine(workspace, diagnostics, PIN, PLATFORM, ARCH, {
        RUNNER_TOOL_CACHE: cacheRoot,
      }),
    ).rejects.toMatchObject({ reason: "engine.acquire.download_failed" });

    await expect(readFile(cachedAssetPath(cacheRoot))).rejects.toThrow();

    // The thrown reason and the recorded diagnostic must agree — an operator reading the log and
    // a caller catching the error are both looking at the same fact.
    const failed = diagnostics.drain().find((r) => r.code === "engine.acquire.download_failed");
    expect(failed?.version).toBe(VERSION);
  });
});

describe("acquireEngine: cache root cannot be written", () => {
  it("still succeeds, over a swallowed cache-write failure, and returns a usable workspace binary", async () => {
    // A plain FILE sitting where the cache needs a DIRECTORY makes `mkdir(..., {recursive:true})`
    // fail deterministically regardless of process privilege level — unlike a chmod'd read-only
    // directory, which a root-run test process (common in CI containers) would simply bypass.
    await mkdir(join(cacheRoot, "keiko-for-quality", "engine"), { recursive: true });
    await writeFile(join(cacheRoot, "keiko-for-quality", "engine", VERSION), "blocked");

    const calls = stubFetchReturning(GOOD_BYTES);
    const result = await acquireEngine(workspace, createSilentDiagnostics(), PIN, PLATFORM, ARCH, {
      RUNNER_TOOL_CACHE: cacheRoot,
    });

    expect(calls).toHaveLength(1);
    expect(result.digest).toBe(GOOD_DIGEST);
    const written = await readFile(result.binaryPath);
    expect(written.equals(GOOD_BYTES)).toBe(true);
  });
});

describe("acquireEngine: digest-mismatched download (existing fail-closed behaviour, now pinned)", () => {
  it("throws AcquisitionError with reason digest_mismatch and never writes a workspace binary", async () => {
    stubFetchReturning(WRONG_BYTES); // does not match PIN's GOOD_DIGEST

    const promise = acquireEngine(workspace, createSilentDiagnostics(), PIN, PLATFORM, ARCH, {
      RUNNER_TOOL_CACHE: cacheRoot,
    });
    await expect(promise).rejects.toThrow(AcquisitionError);
    await expect(promise).rejects.toMatchObject({ reason: "engine.acquire.digest_mismatch" });

    await expect(readFile(join(workspace, "opencodereview"))).rejects.toThrow();
  });
});

describe("acquireEngine: cache-root resolution order", () => {
  it("falls back to XDG_CACHE_HOME when RUNNER_TOOL_CACHE is unset", async () => {
    await mkdir(join(cacheRoot, "keiko-for-quality", "engine", VERSION), { recursive: true });
    await writeFile(cachedAssetPath(cacheRoot), GOOD_BYTES);

    const calls = stubFetchForbidden();
    const result = await acquireEngine(workspace, createSilentDiagnostics(), PIN, PLATFORM, ARCH, {
      XDG_CACHE_HOME: cacheRoot,
    });

    expect(calls).toHaveLength(0);
    expect(result.digest).toBe(GOOD_DIGEST);
  });

  it("prefers RUNNER_TOOL_CACHE over XDG_CACHE_HOME when both are set", async () => {
    const xdgRoot = await mkdtemp(join(tmpdir(), "kfq-acquire-xdg-"));
    try {
      // Seed a valid cache entry only under XDG_CACHE_HOME; RUNNER_TOOL_CACHE (cacheRoot) is empty.
      await mkdir(join(xdgRoot, "keiko-for-quality", "engine", VERSION), { recursive: true });
      await writeFile(cachedAssetPath(xdgRoot), GOOD_BYTES);

      const calls = stubFetchReturning(GOOD_BYTES);
      const result = await acquireEngine(
        workspace,
        createSilentDiagnostics(),
        PIN,
        PLATFORM,
        ARCH,
        {
          RUNNER_TOOL_CACHE: cacheRoot,
          XDG_CACHE_HOME: xdgRoot,
        },
      );

      // RUNNER_TOOL_CACHE won, and it was empty, so this had to download rather than silently
      // reading the XDG-rooted entry.
      expect(calls).toHaveLength(1);
      expect(result.digest).toBe(GOOD_DIGEST);
    } finally {
      await rm(xdgRoot, { recursive: true, force: true });
    }
  });
});
