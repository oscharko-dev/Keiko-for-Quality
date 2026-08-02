import type { CommitSha, Sha256, VersionTag } from "../core/brands.js";
import type { ReasonCode } from "./reason-codes.js";

/**
 * The only fields a diagnostic may carry.
 *
 * There is deliberately no `message`, `detail`, `error`, or any other free-form string. The two
 * string-typed fields are branded, so the only way to populate them is through a validator that has
 * already proved the value is a hexadecimal digest or a version tag. That makes "no raw content in
 * logs" a property of the type system rather than a rule reviewers have to keep enforcing.
 */
export interface DiagnosticFields {
  /** The exact reviewed head. Explicitly allowed: it is public, and it is what an operator needs. */
  readonly headSha?: CommitSha;
  /** Content digests — engine binary, rule profile, result schema. */
  readonly digest?: Sha256;
  /** Tool or schema versions. */
  readonly version?: VersionTag;
  /** Bounded numeric context: counts, sizes, token spend. */
  readonly counts?: Readonly<Record<string, number>>;
  /** Wall-clock duration of the described step. */
  readonly durationMs?: number;
}

export interface DiagnosticRecord extends DiagnosticFields {
  readonly code: ReasonCode;
}

export interface Diagnostics {
  record(code: ReasonCode, fields?: DiagnosticFields): void;
  /** Everything recorded so far, in order. Used by tests and by the run summary. */
  drain(): readonly DiagnosticRecord[];
}

/** Rejects non-finite and non-integer counts so a NaN cannot reach a log line. */
function sanitizeCounts(
  counts: Readonly<Record<string, number>> | undefined,
): Readonly<Record<string, number>> | undefined {
  if (counts === undefined) return undefined;
  const out: Record<string, number> = {};
  for (const [key, value] of Object.entries(counts)) {
    if (!Number.isFinite(value)) continue;
    if (!/^[a-z][a-z0-9_]{0,39}$/.test(key)) continue;
    out[key] = Math.trunc(value);
  }
  return out;
}

function normalize(code: ReasonCode, fields: DiagnosticFields): DiagnosticRecord {
  const counts = sanitizeCounts(fields.counts);
  const duration =
    fields.durationMs !== undefined && Number.isFinite(fields.durationMs)
      ? Math.max(0, Math.trunc(fields.durationMs))
      : undefined;
  return {
    code,
    ...(fields.headSha !== undefined ? { headSha: fields.headSha } : {}),
    ...(fields.digest !== undefined ? { digest: fields.digest } : {}),
    ...(fields.version !== undefined ? { version: fields.version } : {}),
    ...(counts !== undefined ? { counts } : {}),
    ...(duration !== undefined ? { durationMs: duration } : {}),
  };
}

export type DiagnosticWriter = (line: string) => void;

/**
 * Serializes each record as one JSON line.
 *
 * `writer` is the process boundary. In the action it is a stdout write; in tests it is a collector.
 * Nothing else in the product writes to stdout or stderr.
 */
export function createDiagnostics(writer: DiagnosticWriter): Diagnostics {
  const records: DiagnosticRecord[] = [];
  return {
    record(code: ReasonCode, fields: DiagnosticFields = {}): void {
      const entry = normalize(code, fields);
      records.push(entry);
      writer(JSON.stringify(entry));
    },
    drain(): readonly DiagnosticRecord[] {
      return records;
    },
  };
}

/** A sink that records without writing. Used by unit tests and by the local entry point's dry run. */
export function createSilentDiagnostics(): Diagnostics {
  return createDiagnostics(() => undefined);
}
