import { sha256, versionTag, type Sha256, type VersionTag } from "../core/brands.js";

/**
 * The exact Open Code Review release this reviewer executes.
 *
 * This is the single source of truth for the pin. Advancing it is a reviewed change: bump the
 * version, replace every digest from the upstream release's `sha256sum.txt`, and re-run the
 * qualification corpus — the engine binary is part of the qualified configuration, so a new binary
 * invalidates the evidence that the previous one produced.
 *
 * Digests are verified after download and a mismatch fails the run closed. There is deliberately no
 * fallback artifact and no retry against a different asset: the only safe response to a binary that
 * is not the one we qualified is to not run it.
 */
export interface PlatformPin {
  readonly asset: string;
  readonly sha256: Sha256;
}

export interface EnginePin {
  readonly engine: string;
  readonly version: VersionTag;
  readonly releaseUrl: string;
  readonly platforms: Readonly<Record<string, PlatformPin>>;
}

const VERSION = versionTag("v1.8.4");

export const ENGINE_PIN: EnginePin = {
  engine: "alibaba/open-code-review",
  version: VERSION,
  releaseUrl: `https://github.com/alibaba/open-code-review/releases/tag/${VERSION}`,
  platforms: {
    "linux-x64": {
      asset: "opencodereview-linux-amd64",
      sha256: sha256("83a440dda3bae929888cb15e3dddad7c9cc6617af4ca10a7424c89370e7d7e64"),
    },
    "linux-arm64": {
      asset: "opencodereview-linux-arm64",
      sha256: sha256("c5f7c389687a591d0382dcc0be9b61809712624ee1a6d68dc1af437063677384"),
    },
    "darwin-x64": {
      asset: "opencodereview-darwin-amd64",
      sha256: sha256("a529e7536c9abf72379d8dd0a3b1c26e3ba8be817b5b20644ecab75f766b82d4"),
    },
    "darwin-arm64": {
      asset: "opencodereview-darwin-arm64",
      sha256: sha256("484a232e017cee26dd489bd1a1caac1dd2e581ad2d1a45e9b2c37efcc4418b09"),
    },
  },
};

export function assetUrl(pin: EnginePin, asset: string): string {
  return `https://github.com/${pin.engine}/releases/download/${pin.version}/${asset}`;
}

export function platformKey(platform: NodeJS.Platform, arch: string): string {
  return `${platform}-${arch}`;
}

/**
 * The digest this process expects for its own platform, without acquiring anything.
 *
 * Every platform's digest is already known at pin time — `acquireEngine` downloads and *verifies*
 * against it, it does not discover it — so a caller that only needs to know which binary this
 * platform will run, not hold a copy of it, never has to acquire the engine first. This is what
 * lets the v0.9.0 review-cache key include an engine identity before the engine itself has run:
 * the cache key's `engineDigest` is this value, not `AcquiredEngine.digest`, precisely so a cache
 * lookup never forces a download that a hit would have made unnecessary.
 *
 * Returns `undefined` on a platform this pin does not cover, matching `acquireEngine`'s own
 * `engine.acquire.unsupported_platform` failure for the same key — a caller keying a cache lookup
 * on this value treats that as "no trustworthy engine identity yet" and skips memoization for the
 * run rather than acquiring just to find out.
 */
export function currentPlatformDigest(
  pin: EnginePin = ENGINE_PIN,
  platform: NodeJS.Platform = process.platform,
  arch: string = process.arch,
): Sha256 | undefined {
  return pin.platforms[platformKey(platform, arch)]?.sha256;
}
