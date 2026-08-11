import { createHash } from "node:crypto";

import { sha256, type Sha256 } from "../core/brands.js";

/** One immutable ast-grep release archive and the executable proved to be inside it. */
export interface AstGrepPlatformPin {
  readonly asset: string;
  readonly archiveSha256: Sha256;
  readonly binarySha256: Sha256;
}

export interface AstGrepPin {
  readonly repository: string;
  readonly version: string;
  readonly platforms: Readonly<Record<string, AstGrepPlatformPin>>;
}

/**
 * ast-grep is an optional structural retrieval tool, not an npm dependency.
 *
 * The archive digests below are GitHub's own immutable release-asset `digest` values for the
 * signed 0.45.1 release (https://github.com/ast-grep/ast-grep/releases/tag/0.45.1). The executable
 * digests were derived once from the `ast-grep` entry in those already archive-verified assets and
 * are pinned separately so a malformed archive parser can never substitute different bytes.
 *
 * The review engine supports these same four platform keys. Windows is deliberately absent: an
 * unsupported host fails explicitly instead of downloading an unqualified asset.
 */
export const AST_GREP_PIN: AstGrepPin = {
  repository: "ast-grep/ast-grep",
  version: "0.45.1",
  platforms: {
    "linux-x64": {
      asset: "app-x86_64-unknown-linux-gnu.zip",
      archiveSha256: sha256("76fb6555be6734fb5057dba8d2fb756430f374bb9e1af694cf1ce00e13238d63"),
      binarySha256: sha256("6a66162e0a2447af4b7524ee04195239eb1911d07f4868f918909e7d4f453eea"),
    },
    "linux-arm64": {
      asset: "app-aarch64-unknown-linux-gnu.zip",
      archiveSha256: sha256("9ee7ec49aada3dc05135d21977af089a33fc3154ada25bab102daca90b5098f2"),
      binarySha256: sha256("60e154343023011e094230f81f6e50b3d0e58c54efd590b0455723c6f4965b29"),
    },
    "darwin-x64": {
      asset: "app-x86_64-apple-darwin.zip",
      archiveSha256: sha256("38ec2d1c7c97f1efc1c1080526e3c54b964e263478e347f44a65b5287ef5a6ad"),
      binarySha256: sha256("a268555059bc17419a888f9e1b04fb9166546cfe69ea95e1f956e9f19edf4e1e"),
    },
    "darwin-arm64": {
      asset: "app-aarch64-apple-darwin.zip",
      archiveSha256: sha256("6c761afbdc072a7a9006d0dc5c49b3247fef195b8bebe675b4aa385ff872d9c3"),
      binarySha256: sha256("95fc07f6e7fa6fc3fe84f146a93c9abc8515bd67cd9397c5511b6cdf1750d5d0"),
    },
  },
};

function byPlatform(
  [left]: readonly [string, unknown],
  [right]: readonly [string, unknown],
): number {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

export function astGrepRetrievalIdentity(pin: AstGrepPin): string {
  const material = [
    pin.repository,
    pin.version,
    ...Object.entries(pin.platforms)
      .sort(byPlatform)
      .flatMap(([platform, target]) => [
        platform,
        target.asset,
        target.archiveSha256,
        target.binarySha256,
      ]),
  ].join("\u0000");
  return createHash("sha256").update(material, "utf8").digest("hex");
}

/** Cache/release identity over the complete cross-platform pin, not only its mutable version tag. */
export const AST_GREP_RETRIEVAL_IDENTITY = astGrepRetrievalIdentity(AST_GREP_PIN);

export function astGrepAssetUrl(pin: AstGrepPin, asset: string): string {
  return `https://github.com/${pin.repository}/releases/download/${pin.version}/${asset}`;
}

export function astGrepPlatformKey(platform: NodeJS.Platform, arch: string): string {
  return `${platform}-${arch}`;
}
