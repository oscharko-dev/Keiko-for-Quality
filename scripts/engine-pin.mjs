import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { build } from "esbuild";

/**
 * Shared access to the pinned engine release.
 *
 * The pin lives in TypeScript because the product reads it at runtime; these scripts are plain
 * Node ESM outside the TypeScript program. Bundling `pinned-release.ts` on demand is what keeps a
 * single declaration of the pin rather than a second copy that drifts — the digest a consumer
 * executes and the digest a gate verifies must come from the same line of source.
 */
export async function loadPin() {
  return (await loadPinModule()).ENGINE_PIN;
}

/**
 * The product's own platform-key derivation, not a second copy of it.
 *
 * A script that re-derives `${platform}-${arch}` looks identical until the product's rule changes
 * — a renamed key, a new architecture, a different `win32` mapping — and then the script silently
 * looks up a pin that is not the one a consumer executes. Importing it means there is one rule.
 */
export async function loadPlatformKey() {
  return (await loadPinModule()).platformKey;
}

async function loadPinModule() {
  const dir = await mkdtemp(join(tmpdir(), "kfq-pin-"));
  try {
    const outfile = join(dir, "pin.mjs");
    await build({
      entryPoints: ["src/engine/pinned-release.ts"],
      outfile,
      bundle: true,
      platform: "node",
      target: "node24",
      format: "esm",
      logLevel: "silent",
    });
    return await import(`file://${outfile}`);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

export function assetUrl(pin, target) {
  return `https://github.com/${pin.engine}/releases/download/${pin.version}/${target.asset}`;
}

/**
 * Downloads one pinned asset and returns its bytes only if the digest matches.
 *
 * Returning bytes rather than a path is deliberate: a caller that wants the file on disk has to
 * write it itself, which makes it impossible to end up with an unverified file at a path someone
 * later executes.
 */
export async function fetchVerified(pin, platform) {
  const target = pin.platforms[platform];
  if (target === undefined) return { ok: false, reason: `no pin for platform ${platform}` };
  const response = await fetch(assetUrl(pin, target), { redirect: "follow" });
  if (!response.ok) return { ok: false, reason: `HTTP ${String(response.status)}` };
  const bytes = Buffer.from(await response.arrayBuffer());
  const actual = createHash("sha256").update(bytes).digest("hex");
  if (actual !== target.sha256) {
    return { ok: false, reason: `expected ${target.sha256}, got ${actual}` };
  }
  return { ok: true, bytes, sha256: actual, asset: target.asset };
}
