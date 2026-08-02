import { createHash } from "node:crypto";
import { chmod, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

import type { sha256 } from "../core/brands.js";
import type { Diagnostics } from "../diagnostics/sink.js";
import { ENGINE_PIN, assetUrl, platformKey, type EnginePin } from "./pinned-release.js";

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

async function download(url: string): Promise<Buffer> {
  const response = await fetch(url, { redirect: "follow" });
  if (!response.ok) throw new AcquisitionError("engine.acquire.download_failed");
  const declared = Number(response.headers.get("content-length") ?? "0");
  if (declared > MAX_BINARY_BYTES) throw new AcquisitionError("engine.acquire.download_failed");
  const bytes = Buffer.from(await response.arrayBuffer());
  if (bytes.byteLength === 0 || bytes.byteLength > MAX_BINARY_BYTES) {
    throw new AcquisitionError("engine.acquire.download_failed");
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
 * Downloads the pinned engine and proves it is the artifact we qualified.
 *
 * The digest is compared before the file is ever made executable. A mismatch is terminal: there is
 * no second attempt and no alternative asset, because the only situations that produce one are a
 * corrupted transfer, a moved upstream tag, or a substituted artifact — and none of those should
 * end with this process running the result.
 */
export async function acquireEngine(
  directory: string,
  diagnostics: Diagnostics,
  pin: EnginePin = ENGINE_PIN,
  platform: NodeJS.Platform = process.platform,
  arch: string = process.arch,
): Promise<AcquiredEngine> {
  const key = platformKey(platform, arch);
  const target = pin.platforms[key];
  if (target === undefined) {
    diagnostics.record("engine.acquire.unsupported_platform", { version: pin.version });
    throw new AcquisitionError("engine.acquire.unsupported_platform");
  }

  const started = Date.now();
  const bytes = await download(assetUrl(pin, target.asset));
  const actual = digestOf(bytes);
  if (actual !== (target.sha256 as string)) {
    diagnostics.record("engine.acquire.digest_mismatch", {
      version: pin.version,
      digest: target.sha256,
    });
    throw new AcquisitionError("engine.acquire.digest_mismatch");
  }

  await mkdir(directory, { recursive: true, mode: 0o700 });
  const binaryPath = join(directory, "opencodereview");
  await writeFile(binaryPath, bytes, { mode: 0o700 });
  await chmod(binaryPath, 0o700);

  diagnostics.record("engine.acquire.verified", {
    version: pin.version,
    digest: target.sha256,
    durationMs: Date.now() - started,
    counts: { bytes: bytes.byteLength },
  });

  return { binaryPath, digest: target.sha256 };
}
