import { createHash } from "node:crypto";
import { chmod, mkdir, mkdtemp, open, rm, writeFile } from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { ReadableStreamDefaultReader } from "node:stream/web";

import {
  extractAstGrepBinary,
  MAX_AST_GREP_ARCHIVE_BYTES,
  MAX_AST_GREP_BINARY_BYTES,
} from "./ast-grep-archive.js";
import {
  AST_GREP_PIN,
  astGrepAssetUrl,
  astGrepPlatformKey,
  type AstGrepPin,
  type AstGrepPlatformPin,
} from "./ast-grep-pin.js";

export { AST_GREP_PIN } from "./ast-grep-pin.js";

const DOWNLOAD_TIMEOUT_MS = 20_000;

export class AstGrepAcquisitionError extends Error {
  public readonly reason:
    | "ast_grep.unsupported_platform"
    | "ast_grep.download_failed"
    | "ast_grep.archive_digest_mismatch"
    | "ast_grep.archive_invalid"
    | "ast_grep.binary_digest_mismatch";

  public constructor(reason: AstGrepAcquisitionError["reason"], cause?: unknown) {
    super(reason, { cause });
    this.name = "AstGrepAcquisitionError";
    this.reason = reason;
  }
}

function digestOf(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function cacheRoot(env: NodeJS.ProcessEnv): string {
  const runnerToolCache = env.RUNNER_TOOL_CACHE;
  if (runnerToolCache !== undefined && runnerToolCache.length > 0) return runnerToolCache;
  const xdgCacheHome = env.XDG_CACHE_HOME;
  if (xdgCacheHome !== undefined && xdgCacheHome.length > 0) return xdgCacheHome;
  return join(homedir(), ".cache");
}

function cachedBinaryPath(env: NodeJS.ProcessEnv, pin: AstGrepPin, platformKey: string): string {
  return join(
    cacheRoot(env),
    "keiko-for-quality",
    "ast-grep",
    pin.version,
    platformKey,
    "ast-grep",
  );
}

async function readBoundedFile(path: string, maximum: number): Promise<Buffer | undefined> {
  let handle: FileHandle | undefined;
  try {
    handle = await open(path, "r");
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size < 1 || stat.size > maximum) return undefined;
    const bytes = Buffer.alloc(stat.size);
    let offset = 0;
    while (offset < bytes.byteLength) {
      const read = await handle.read(bytes, offset, bytes.byteLength - offset, offset);
      if (read.bytesRead === 0) return undefined;
      offset += read.bytesRead;
    }
    const extra = Buffer.alloc(1);
    if ((await handle.read(extra, 0, 1, bytes.byteLength)).bytesRead !== 0) return undefined;
    return bytes;
  } catch {
    return undefined;
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

async function validCachedBinary(
  path: string,
  target: AstGrepPlatformPin,
): Promise<Buffer | undefined> {
  const bytes = await readBoundedFile(path, MAX_AST_GREP_BINARY_BYTES);
  if (bytes !== undefined && digestOf(bytes) === (target.binarySha256 as string)) return bytes;
  await rm(path, { force: true }).catch(() => undefined);
  return undefined;
}

async function readResponseBounded(response: Response): Promise<Buffer | undefined> {
  const reader = response.body?.getReader() as ReadableStreamDefaultReader<Uint8Array> | undefined;
  if (reader === undefined) return undefined;
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > MAX_AST_GREP_ARCHIVE_BYTES) {
        await reader.cancel();
        return undefined;
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  return total === 0 ? undefined : Buffer.concat(chunks);
}

function acquisitionTimeoutMs(deadlineMs: number | undefined): number {
  if (deadlineMs === undefined) return DOWNLOAD_TIMEOUT_MS;
  const remaining = Math.max(0, Math.trunc(deadlineMs - Date.now()));
  if (remaining === 0) {
    throw new AstGrepAcquisitionError("ast_grep.download_failed");
  }
  return Math.min(DOWNLOAD_TIMEOUT_MS, remaining);
}

async function downloadArchive(
  pin: AstGrepPin,
  target: AstGrepPlatformPin,
  deadlineMs?: number,
): Promise<Buffer> {
  try {
    const response = await fetch(astGrepAssetUrl(pin, target.asset), {
      redirect: "follow",
      signal: AbortSignal.timeout(acquisitionTimeoutMs(deadlineMs)),
    });
    const declared = Number(response.headers.get("content-length") ?? "0");
    if (!response.ok || declared > MAX_AST_GREP_ARCHIVE_BYTES) throw new Error("download failed");
    const archive = await readResponseBounded(response);
    if (archive === undefined) throw new Error("download failed");
    return archive;
  } catch (error) {
    throw new AstGrepAcquisitionError("ast_grep.download_failed", error);
  }
}

function verifiedBinaryFromArchive(archive: Buffer, target: AstGrepPlatformPin): Buffer {
  if (digestOf(archive) !== (target.archiveSha256 as string)) {
    throw new AstGrepAcquisitionError("ast_grep.archive_digest_mismatch");
  }
  let binary: Buffer;
  try {
    binary = extractAstGrepBinary(archive);
  } catch (error) {
    throw new AstGrepAcquisitionError("ast_grep.archive_invalid", error);
  }
  if (digestOf(binary) !== (target.binarySha256 as string)) {
    throw new AstGrepAcquisitionError("ast_grep.binary_digest_mismatch");
  }
  return binary;
}

/** Networked release audit used by the explicit pin check; ordinary `verify` never calls it. */
export async function fetchVerifiedAstGrepAsset(
  pin: AstGrepPin,
  target: AstGrepPlatformPin,
): Promise<{ readonly archiveBytes: number; readonly binaryBytes: number }> {
  const archive = await downloadArchive(pin, target);
  const binary = verifiedBinaryFromArchive(archive, target);
  return { archiveBytes: archive.byteLength, binaryBytes: binary.byteLength };
}

async function populateCache(path: string, binary: Buffer): Promise<void> {
  let handle: FileHandle | undefined;
  try {
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    // Exclusive creation refuses an attacker-created symlink or stale entry instead of following
    // it. This cache is optional; a concurrent writer winning the race costs only this write.
    handle = await open(path, "wx", 0o600);
    await handle.writeFile(binary);
  } catch {
    // The cache is only an optimization; the separately written private executable is authoritative.
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

/** Acquires a digest-verified ast-grep binary and writes only verified bytes as executable. */
export async function acquireAstGrep(
  directory: string,
  pin: AstGrepPin = AST_GREP_PIN,
  platform: NodeJS.Platform = process.platform,
  arch: string = process.arch,
  env: NodeJS.ProcessEnv = process.env,
  deadlineMs?: number,
): Promise<string> {
  const key = astGrepPlatformKey(platform, arch);
  const target = pin.platforms[key];
  if (target === undefined) throw new AstGrepAcquisitionError("ast_grep.unsupported_platform");
  const cachedPath = cachedBinaryPath(env, pin, key);
  let binary = await validCachedBinary(cachedPath, target);
  if (binary === undefined) {
    binary = verifiedBinaryFromArchive(await downloadArchive(pin, target, deadlineMs), target);
    await populateCache(cachedPath, binary);
  }
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const binaryPath = join(directory, "ast-grep");
  await writeFile(binaryPath, binary, { mode: 0o700 });
  await chmod(binaryPath, 0o700);
  return binaryPath;
}

let defaultBinary: Promise<string> | undefined;

function waitForDefaultBinary(binaryPromise: Promise<string>, deadlineMs: number): Promise<string> {
  const remaining = Math.max(0, Math.trunc(deadlineMs - Date.now()));
  if (remaining === 0) {
    return Promise.reject(new AstGrepAcquisitionError("ast_grep.download_failed"));
  }
  return new Promise<string>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new AstGrepAcquisitionError("ast_grep.download_failed"));
    }, remaining);
    void binaryPromise.then(
      (path) => {
        clearTimeout(timer);
        resolve(path);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(
          error instanceof Error ? error : new AstGrepAcquisitionError("ast_grep.download_failed"),
        );
      },
    );
  });
}

/** One private executable per process; repeated follow-ups reuse it after the same digest proof. */
export function acquireDefaultAstGrep(deadlineMs?: number): Promise<string> {
  if (deadlineMs !== undefined) acquisitionTimeoutMs(deadlineMs);
  if (defaultBinary === undefined) {
    const acquisition = mkdtemp(join(tmpdir(), "kfq-ast-grep-")).then((directory) =>
      acquireAstGrep(
        directory,
        AST_GREP_PIN,
        process.platform,
        process.arch,
        process.env,
        deadlineMs,
      ),
    );
    defaultBinary = acquisition;
    void acquisition.catch(() => {
      if (defaultBinary === acquisition) defaultBinary = undefined;
    });
  }
  return deadlineMs === undefined ? defaultBinary : waitForDefaultBinary(defaultBinary, deadlineMs);
}
