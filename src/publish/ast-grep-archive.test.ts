import { deflateRawSync } from "node:zlib";

import { describe, expect, it } from "vitest";

import {
  AstGrepArchiveError,
  MAX_AST_GREP_BINARY_BYTES,
  crc32,
  extractAstGrepBinary,
} from "./ast-grep-archive.js";

function zipEntry(name: string, content: Buffer, method: 0 | 8): Buffer {
  const encodedName = Buffer.from(name, "utf8");
  const payload = method === 0 ? content : deflateRawSync(content);
  const crc = crc32(content);
  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50, 0);
  local.writeUInt16LE(method, 8);
  local.writeUInt32LE(crc, 14);
  local.writeUInt32LE(payload.byteLength, 18);
  local.writeUInt32LE(content.byteLength, 22);
  local.writeUInt16LE(encodedName.byteLength, 26);
  const central = Buffer.alloc(46);
  central.writeUInt32LE(0x02014b50, 0);
  central.writeUInt16LE(method, 10);
  central.writeUInt32LE(crc, 16);
  central.writeUInt32LE(payload.byteLength, 20);
  central.writeUInt32LE(content.byteLength, 24);
  central.writeUInt16LE(encodedName.byteLength, 28);
  const localRecord = Buffer.concat([local, encodedName, payload]);
  const centralRecord = Buffer.concat([central, encodedName]);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(1, 8);
  eocd.writeUInt16LE(1, 10);
  eocd.writeUInt32LE(centralRecord.byteLength, 12);
  eocd.writeUInt32LE(localRecord.byteLength, 16);
  return Buffer.concat([localRecord, centralRecord, eocd]);
}

describe("extractAstGrepBinary", () => {
  it.each([0, 8] as const)("extracts one CRC-checked method %s executable", (method) => {
    const binary = Buffer.from("trusted ast-grep fixture");
    expect(extractAstGrepBinary(zipEntry("ast-grep", binary, method))).toEqual(binary);
  });

  it("rejects path traversal before considering payload bytes", () => {
    expect(() => extractAstGrepBinary(zipEntry("../ast-grep", Buffer.from("x"), 0))).toThrow(
      AstGrepArchiveError,
    );
  });

  it("rejects a CRC mismatch", () => {
    const archive = zipEntry("ast-grep", Buffer.from("trusted"), 0);
    const payload = 30 + "ast-grep".length;
    archive[payload] = (archive[payload] ?? 0) ^ 0xff;
    expect(() => extractAstGrepBinary(archive)).toThrow(AstGrepArchiveError);
  });

  it("rejects a declared ZIP bomb before inflating it", () => {
    const archive = zipEntry("ast-grep", Buffer.from("small"), 8);
    const central = archive.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]));
    archive.writeUInt32LE(MAX_AST_GREP_BINARY_BYTES + 1, 22);
    archive.writeUInt32LE(MAX_AST_GREP_BINARY_BYTES + 1, central + 24);
    expect(() => extractAstGrepBinary(archive)).toThrow(AstGrepArchiveError);
  });

  it("rejects malformed archives and unsupported compression", () => {
    expect(() => extractAstGrepBinary(Buffer.from("not a zip"))).toThrow(AstGrepArchiveError);
    const archive = zipEntry("ast-grep", Buffer.from("x"), 0);
    const central = archive.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]));
    archive.writeUInt16LE(99, 8);
    archive.writeUInt16LE(99, central + 10);
    expect(() => extractAstGrepBinary(archive)).toThrow(AstGrepArchiveError);
  });
});
