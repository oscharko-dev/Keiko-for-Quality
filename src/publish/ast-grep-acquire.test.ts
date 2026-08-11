import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { sha256 } from "../core/brands.js";
import { crc32 } from "./ast-grep-archive.js";
import { acquireAstGrep, AstGrepAcquisitionError } from "./ast-grep-acquire.js";
import type { AstGrepPin } from "./ast-grep-pin.js";

const originalFetch = globalThis.fetch;
const binary = Buffer.from("fixture ast-grep executable");

function digest(bytes: Buffer): ReturnType<typeof sha256> {
  return sha256(createHash("sha256").update(bytes).digest("hex"));
}

function storedZip(content: Buffer): Buffer {
  const name = Buffer.from("ast-grep");
  const crc = crc32(content);
  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50, 0);
  local.writeUInt32LE(crc, 14);
  local.writeUInt32LE(content.byteLength, 18);
  local.writeUInt32LE(content.byteLength, 22);
  local.writeUInt16LE(name.byteLength, 26);
  const central = Buffer.alloc(46);
  central.writeUInt32LE(0x02014b50, 0);
  central.writeUInt32LE(crc, 16);
  central.writeUInt32LE(content.byteLength, 20);
  central.writeUInt32LE(content.byteLength, 24);
  central.writeUInt16LE(name.byteLength, 28);
  const localRecord = Buffer.concat([local, name, content]);
  const centralRecord = Buffer.concat([central, name]);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(1, 8);
  eocd.writeUInt16LE(1, 10);
  eocd.writeUInt32LE(centralRecord.byteLength, 12);
  eocd.writeUInt32LE(localRecord.byteLength, 16);
  return Buffer.concat([localRecord, centralRecord, eocd]);
}

const archive = storedZip(binary);
const pin: AstGrepPin = {
  repository: "example/ast-grep",
  version: "1.2.3",
  platforms: {
    "linux-x64": {
      asset: "fixture.zip",
      archiveSha256: digest(archive),
      binarySha256: digest(binary),
    },
  },
};

let cache: string;
let workspace: string;

beforeEach(async () => {
  cache = await mkdtemp(join(tmpdir(), "kfq-ast-grep-cache-"));
  workspace = await mkdtemp(join(tmpdir(), "kfq-ast-grep-workspace-"));
});

afterEach(async () => {
  globalThis.fetch = originalFetch;
  await rm(cache, { recursive: true, force: true });
  await rm(workspace, { recursive: true, force: true });
});

function stubFetch(bytes: Buffer): string[] {
  const calls: string[] = [];
  globalThis.fetch = ((input: string | URL | Request) => {
    calls.push(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    return Promise.resolve(
      new Response(bytes, {
        status: 200,
        headers: { "content-length": String(bytes.byteLength) },
      }),
    );
  }) as typeof fetch;
  return calls;
}

describe("acquireAstGrep", () => {
  it("does not start a download after the enclosing review deadline", async () => {
    const calls = stubFetch(archive);
    await expect(
      acquireAstGrep(workspace, pin, "linux", "x64", { RUNNER_TOOL_CACHE: cache }, Date.now() - 1),
    ).rejects.toBeInstanceOf(AstGrepAcquisitionError);
    expect(calls).toHaveLength(0);
  });

  it("verifies both archive and executable before caching and making bytes executable", async () => {
    const calls = stubFetch(archive);
    const path = await acquireAstGrep(workspace, pin, "linux", "x64", {
      RUNNER_TOOL_CACHE: cache,
    });

    expect(calls).toHaveLength(1);
    expect(await readFile(path)).toEqual(binary);
    const cached = join(cache, "keiko-for-quality", "ast-grep", "1.2.3", "linux-x64", "ast-grep");
    expect(await readFile(cached)).toEqual(binary);
  });

  it("uses only a digest-valid cache entry", async () => {
    stubFetch(archive);
    await acquireAstGrep(workspace, pin, "linux", "x64", { RUNNER_TOOL_CACHE: cache });
    const calls = stubFetch(Buffer.from("must not be fetched"));
    const second = await mkdtemp(join(tmpdir(), "kfq-ast-grep-second-"));
    try {
      await acquireAstGrep(second, pin, "linux", "x64", { RUNNER_TOOL_CACHE: cache });
      expect(calls).toHaveLength(0);
    } finally {
      await rm(second, { recursive: true, force: true });
    }
  });

  it("never follows a poisoned cache symlink when replacing invalid bytes", async () => {
    const cached = join(cache, "keiko-for-quality", "ast-grep", "1.2.3", "linux-x64", "ast-grep");
    await mkdir(join(cached, ".."), { recursive: true });
    const target = join(cache, "must-not-be-overwritten");
    await writeFile(target, "sentinel");
    await symlink(target, cached);
    stubFetch(archive);

    await acquireAstGrep(workspace, pin, "linux", "x64", { RUNNER_TOOL_CACHE: cache });

    expect(await readFile(target, "utf8")).toBe("sentinel");
    expect(await readFile(cached)).toEqual(binary);
  });

  it("fails explicitly on an unsupported host without fetching", async () => {
    const calls = stubFetch(archive);
    await expect(
      acquireAstGrep(workspace, pin, "win32", "x64", { RUNNER_TOOL_CACHE: cache }),
    ).rejects.toMatchObject({ reason: "ast_grep.unsupported_platform" });
    expect(calls).toHaveLength(0);
  });

  it("fails closed on archive and extracted-binary digest mismatches", async () => {
    stubFetch(Buffer.from("wrong archive"));
    await expect(
      acquireAstGrep(workspace, pin, "linux", "x64", { RUNNER_TOOL_CACHE: cache }),
    ).rejects.toMatchObject({ reason: "ast_grep.archive_digest_mismatch" });

    stubFetch(archive);
    const wrongBinaryPin: AstGrepPin = {
      ...pin,
      platforms: {
        "linux-x64": { ...pin.platforms["linux-x64"]!, binarySha256: sha256("a".repeat(64)) },
      },
    };
    await expect(
      acquireAstGrep(workspace, wrongBinaryPin, "linux", "x64", {
        RUNNER_TOOL_CACHE: join(cache, "other"),
      }),
    ).rejects.toMatchObject({ reason: "ast_grep.binary_digest_mismatch" });
  });

  it("uses a closed acquisition error vocabulary", () => {
    expect(new AstGrepAcquisitionError("ast_grep.download_failed").message).toBe(
      "ast_grep.download_failed",
    );
  });
});
