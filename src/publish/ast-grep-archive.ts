import { inflateRawSync } from "node:zlib";

export const MAX_AST_GREP_ARCHIVE_BYTES = 32 * 1024 * 1024;
export const MAX_AST_GREP_BINARY_BYTES = 64 * 1024 * 1024;

const EOCD_SIGNATURE = 0x06054b50;
const CENTRAL_SIGNATURE = 0x02014b50;
const LOCAL_SIGNATURE = 0x04034b50;
const MAX_EOCD_SEARCH = 65_557;
const ALLOWED_FLAGS = 0x0808; // UTF-8 names and/or a trailing data descriptor.
const ALLOWED_ENTRIES: ReadonlySet<string> = new Set(["ast-grep", "sg"]);

export class AstGrepArchiveError extends Error {
  public constructor() {
    super("invalid pinned ast-grep archive");
    this.name = "AstGrepArchiveError";
  }
}

interface ZipEntry {
  readonly name: string;
  readonly flags: number;
  readonly method: number;
  readonly crc: number;
  readonly compressedSize: number;
  readonly uncompressedSize: number;
  readonly localOffset: number;
}

interface CentralDirectory {
  readonly offset: number;
  readonly size: number;
  readonly entries: number;
}

function invalid(): never {
  throw new AstGrepArchiveError();
}

function boundedSlice(bytes: Buffer, start: number, length: number): Buffer {
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(length) || start < 0 || length < 0) {
    invalid();
  }
  const end = start + length;
  if (!Number.isSafeInteger(end) || end > bytes.byteLength) invalid();
  return bytes.subarray(start, end);
}

function findEocd(bytes: Buffer): number {
  const floor = Math.max(0, bytes.byteLength - MAX_EOCD_SEARCH);
  for (let cursor = bytes.byteLength - 22; cursor >= floor; cursor -= 1) {
    if (bytes.readUInt32LE(cursor) !== EOCD_SIGNATURE) continue;
    const commentLength = bytes.readUInt16LE(cursor + 20);
    if (cursor + 22 + commentLength === bytes.byteLength) return cursor;
  }
  return invalid();
}

function centralDirectory(bytes: Buffer): CentralDirectory {
  const eocd = findEocd(bytes);
  const disk = bytes.readUInt16LE(eocd + 4);
  const centralDisk = bytes.readUInt16LE(eocd + 6);
  const diskEntries = bytes.readUInt16LE(eocd + 8);
  const entries = bytes.readUInt16LE(eocd + 10);
  const size = bytes.readUInt32LE(eocd + 12);
  const offset = bytes.readUInt32LE(eocd + 16);
  if (disk !== 0 || centralDisk !== 0 || diskEntries !== entries || entries < 1 || entries > 4) {
    invalid();
  }
  if (offset + size !== eocd || offset < 0 || size < 46) invalid();
  return { offset, size, entries };
}

function safeEntryName(bytes: Buffer): string {
  const name = bytes.toString("utf8");
  if (!ALLOWED_ENTRIES.has(name) || Buffer.from(name, "utf8").compare(bytes) !== 0) invalid();
  return name;
}

function parseCentralEntry(bytes: Buffer, cursor: number): { entry: ZipEntry; next: number } {
  if (boundedSlice(bytes, cursor, 46).readUInt32LE(0) !== CENTRAL_SIGNATURE) invalid();
  const flags = bytes.readUInt16LE(cursor + 8);
  const method = bytes.readUInt16LE(cursor + 10);
  const nameLength = bytes.readUInt16LE(cursor + 28);
  const extraLength = bytes.readUInt16LE(cursor + 30);
  const commentLength = bytes.readUInt16LE(cursor + 32);
  const next = cursor + 46 + nameLength + extraLength + commentLength;
  if ((flags & ~ALLOWED_FLAGS) !== 0 || (method !== 0 && method !== 8)) invalid();
  const name = safeEntryName(boundedSlice(bytes, cursor + 46, nameLength));
  const compressedSize = bytes.readUInt32LE(cursor + 20);
  const uncompressedSize = bytes.readUInt32LE(cursor + 24);
  if (
    compressedSize < 1 ||
    compressedSize > MAX_AST_GREP_ARCHIVE_BYTES ||
    uncompressedSize < 1 ||
    uncompressedSize > MAX_AST_GREP_BINARY_BYTES
  ) {
    invalid();
  }
  return {
    entry: {
      name,
      flags,
      method,
      crc: bytes.readUInt32LE(cursor + 16),
      compressedSize,
      uncompressedSize,
      localOffset: bytes.readUInt32LE(cursor + 42),
    },
    next,
  };
}

function entriesFromCentral(bytes: Buffer, directory: CentralDirectory): readonly ZipEntry[] {
  const entries: ZipEntry[] = [];
  const names = new Set<string>();
  let cursor = directory.offset;
  for (let index = 0; index < directory.entries; index += 1) {
    const parsed = parseCentralEntry(bytes, cursor);
    if (parsed.next > directory.offset + directory.size || names.has(parsed.entry.name)) invalid();
    names.add(parsed.entry.name);
    entries.push(parsed.entry);
    cursor = parsed.next;
  }
  if (cursor !== directory.offset + directory.size) invalid();
  return entries;
}

function compressedPayload(bytes: Buffer, entry: ZipEntry, centralOffset: number): Buffer {
  const header = boundedSlice(bytes, entry.localOffset, 30);
  if (header.readUInt32LE(0) !== LOCAL_SIGNATURE) invalid();
  const flags = header.readUInt16LE(6);
  const method = header.readUInt16LE(8);
  const nameLength = header.readUInt16LE(26);
  const extraLength = header.readUInt16LE(28);
  const localName = safeEntryName(boundedSlice(bytes, entry.localOffset + 30, nameLength));
  if (flags !== entry.flags || method !== entry.method || localName !== entry.name) invalid();
  if ((flags & 0x0008) === 0) {
    if (
      header.readUInt32LE(14) !== entry.crc ||
      header.readUInt32LE(18) !== entry.compressedSize ||
      header.readUInt32LE(22) !== entry.uncompressedSize
    ) {
      invalid();
    }
  }
  const start = entry.localOffset + 30 + nameLength + extraLength;
  if (start + entry.compressedSize > centralOffset) invalid();
  return boundedSlice(bytes, start, entry.compressedSize);
}

function crcTable(): Uint32Array {
  const table = new Uint32Array(256);
  for (let value = 0; value < 256; value += 1) {
    let current = value;
    for (let bit = 0; bit < 8; bit += 1) {
      current = (current & 1) === 1 ? 0xedb88320 ^ (current >>> 1) : current >>> 1;
    }
    table[value] = current >>> 0;
  }
  return table;
}

const CRC_TABLE = crcTable();

export function crc32(bytes: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of bytes) crc = (crc >>> 8) ^ (CRC_TABLE[(crc ^ byte) & 0xff] ?? 0);
  return (crc ^ 0xffffffff) >>> 0;
}

function inflateEntry(payload: Buffer, entry: ZipEntry): Buffer {
  if (entry.uncompressedSize < 1 || entry.uncompressedSize > MAX_AST_GREP_BINARY_BYTES) invalid();
  if (entry.compressedSize < 1 || entry.compressedSize > MAX_AST_GREP_ARCHIVE_BYTES) invalid();
  try {
    const output =
      entry.method === 0
        ? Buffer.from(payload)
        : inflateRawSync(payload, { maxOutputLength: MAX_AST_GREP_BINARY_BYTES });
    if (output.byteLength !== entry.uncompressedSize || crc32(output) !== entry.crc) invalid();
    return output;
  } catch (error) {
    if (error instanceof AstGrepArchiveError) throw error;
    return invalid();
  }
}

/** Extracts exactly the pinned executable entry; every archive path is closed-vocabulary checked. */
export function extractAstGrepBinary(archive: Buffer): Buffer {
  if (archive.byteLength < 22 || archive.byteLength > MAX_AST_GREP_ARCHIVE_BYTES) invalid();
  const directory = centralDirectory(archive);
  const entries = entriesFromCentral(archive, directory);
  const binary = entries.find((entry) => entry.name === "ast-grep");
  if (binary === undefined) invalid();
  const payload = compressedPayload(archive, binary, directory.offset);
  return inflateEntry(payload, binary);
}
