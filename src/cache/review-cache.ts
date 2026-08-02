import { createHash } from "node:crypto";

import {
  ValidationError,
  blobId,
  hasControlCharacters,
  repoPath,
  sha256,
  type BlobId,
  type Sha256,
} from "../core/brands.js";
import {
  asArray,
  asInteger,
  asObject,
  asString,
  parseJson,
  rejectUnknownKeys,
  requireKeys,
} from "../core/validate.js";
import type { EngineFinding } from "../engine/result.js";

/**
 * Cross-run memoization of per-file review findings.
 *
 * One entry answers one question: "for this exact base/head content pair, reviewed by this exact
 * rule text, this exact engine binary, this exact model, over this exact wire protocol, what did
 * the engine find?" The consumer workflow persists the serialized store as a GitHub Actions cache
 * artifact and restores it before the next run, so a pull request that only touches files the
 * store already has an answer for can skip invoking the engine for those files entirely.
 *
 * **Why replaying is sound.** A cache is only trustworthy when hitting it is at least as good as
 * not hitting it. Five of the six key inputs are exact-match content addresses (a Git blob id is
 * the content, not a name for it) or exact-match configuration pins — the same base blob, the same
 * head blob, the same rule text digest, and the same engine binary digest mean the engine received
 * byte-identical instructions and byte-identical input on both occasions. The sixth, the model, is
 * not deterministic between calls even when everything else is held constant. That is exactly why
 * replay is the right move rather than the wrong one: a fresh call under identical conditions is
 * still a nondeterministic draw, not a more authoritative answer, so returning the finding list a
 * real, completed review already produced under those identical conditions is not a weaker result
 * than rolling the dice again — it is the same class of result, obtained without spending the
 * model budget or the wall-clock a second time.
 *
 * **Why the store lives in the base-context Actions cache.** GitHub scopes cache writes by the
 * permissions of the token that requests them, and a workflow run triggered by a fork's pull
 * request executes with a read-only token: it may restore an existing cache entry but cannot save
 * one. A fork-originated head is only ever a candidate whose content is being judged, never a
 * source this reviewer would treat as having produced a trustworthy verdict — SECURITY.md already
 * excludes it from model review entirely — so the same boundary that keeps a fork from spending the
 * model budget also keeps it from writing a cache entry that a later, trusted run would replay
 * without ever calling the engine.
 *
 * **Why an incomplete run must never write an entry.** A `Settlement` of `"incomplete"` means the
 * engine did not finish answering the coverage question for this run, for reasons ranging from a
 * timeout to a rejected schema to a budget ceiling. Caching whatever finding list happened to exist
 * at that moment — often empty — would silently launder a transient failure into a permanent,
 * confidently-replayed "no findings" for that exact content pair, and every future run with the same
 * blobs, rule, engine, and model would inherit the gap without ever seeing a coverage problem to
 * report. Only a `"complete"` settlement's findings may become a cache entry.
 *
 * **The honest residual.** This store cannot distinguish a legitimately produced entry from one a
 * trusted workflow run chose to write with fabricated (for example, deliberately emptied) findings
 * for a real blob pair. A same-repository contributor with write access to workflows already runs
 * in the base context this store trusts, and could add or edit a job that writes such an entry.
 * That is not a gap specific to this module — it is the same repository trust boundary ADR-0170 D4
 * names for the model credential and the publishing identity: the platform does not prevent a
 * reviewed, merged change to the protected base from doing this, and it is that review gate, not a
 * property of the cache format, that is the actual defense.
 *
 * **Why `prPathSetDigest` exists (v0.10.0, issue #50).** The six inputs above prove a file's own
 * content, rule text, and engine were byte-identical across two runs — they say nothing about the
 * *rest* of the pull request. Since v0.6.0 the reviewer verifies claims against the repository
 * before publishing, so a verdict for one file can depend on another file's import surface, a
 * caller, or configuration that changed while the first file's own bytes did not. Replaying it
 * without looking again is exactly that staleness, and this field bounds it: every entry also
 * carries a digest of the sorted set of changed path *names* across the whole pull request at the
 * time it was written, and a lookup additionally requires that digest to equal the current run's
 * (`computePathSetDigest`). Names, never blobs — a per-file content digest would already differ on
 * every touched file and defeat memoization outright, so this deliberately asks a coarser, cheaper
 * question instead: did the *shape* of the changed-file set move? A rename folds the path it moved
 * from into its token rather than contributing only its new name, because an old path silently
 * disappearing from the diff is exactly the kind of context change an unrelated file's cached
 * verdict cannot see for itself. This is a bound, not a fix: a push that only edits files already
 * in the diff still replays their untouched neighbours unconditionally, which is the same
 * staleness every content/commit-scoped incremental reviewer on the market accepts. Sound
 * dependency-closure invalidation is left to a later version; this is the cheap, O(1) mitigation
 * that kills the sharpest edge — a brand-new file introducing new import surface next to memoized
 * neighbours.
 */

/**
 * The store schema this module reads and writes. Bump on any incompatible shape change.
 *
 * v2 (v0.10.0, issue #50) added `prPathSetDigest` to every entry. There is deliberately no
 * migration: a store still carrying the retired v1 marker fails this exact-match check the same
 * way any other unrecognised schema does, and the run starts from an empty store. Memoization is a
 * pure optimization layer, so losing one session's worth of entries costs only re-review spend,
 * never coverage — see this module's own "why an incomplete run must never write an entry"
 * reasoning above for the sibling case this mirrors.
 */
export const SUPPORTED_STORE_SCHEMA = "keiko-for-quality.review-cache/v2";

declare const cacheBrand: unique symbol;
type CacheBrand<T, B extends string> = T & { readonly [cacheBrand]: B };

/**
 * The Git blob object id this module keys on.
 *
 * `core/brands.ts` already defines `BlobId` for the same purpose (`git/plumbing.ts`'s raw diff
 * parsing), so this module re-exports that one brand rather than declaring a second, structurally
 * identical type under the same name — two distinct brands called `BlobId` would let a caller
 * satisfy either function's parameter with the other's value, defeating the whole point of
 * branding. `blobId` is re-exported alongside it so a caller of this module never has to reach into
 * `core/brands.ts` just to construct the value this module's own functions require.
 */
export type { BlobId };
export { blobId };

/** The model identifier a run was configured with. Free-form but bounded and control-character-free. */
export type ModelId = CacheBrand<string, "ModelId">;

/** The wire protocol the model endpoint spoke for a run. Mirrors `config/runtime.ts`'s two values. */
export type Protocol = "openai" | "anthropic";

/**
 * The composite cache key: a sha256 over all six inputs that determine whether a past finding list
 * may be replayed. Kept as its own brand rather than reusing `Sha256` even though the two share a
 * shape, so a caller cannot pass a bare content digest — a rule digest, say — to `lookup` where a
 * key computed from all six inputs was required.
 */
export type CacheKey = CacheBrand<string, "CacheKey">;

const CACHE_KEY_PATTERN = /^[0-9a-f]{64}$/;
const PROTOCOLS: ReadonlySet<string> = new Set<string>(["openai", "anthropic"]);
const FIELD_SEPARATOR = "\0";

/** Bounds for parsing an untrusted, persisted store. Exported so tests can target them exactly. */
export const PARSE_LIMITS = {
  maxStoreBytes: 4 * 1024 * 1024,
  maxEntries: 20_000,
  maxFindingsPerEntry: 1000,
  maxFindingContentChars: 20_000,
  maxLine: 10_000_000,
  maxModelIdChars: 256,
} as const;

export function modelId(value: string, field = "modelId"): ModelId {
  if (value.length === 0 || value.length > PARSE_LIMITS.maxModelIdChars) {
    throw new ValidationError(field);
  }
  if (hasControlCharacters(value)) throw new ValidationError(field);
  return value as ModelId;
}

export function protocol(value: string, field = "protocol"): Protocol {
  if (!PROTOCOLS.has(value)) throw new ValidationError(field);
  return value as Protocol;
}

/** Validates a cache key already believed to be one, e.g. one just read back from storage. */
function toCacheKey(value: string, field: string): CacheKey {
  if (!CACHE_KEY_PATTERN.test(value)) throw new ValidationError(field);
  return value as CacheKey;
}

/**
 * Computes the composite key from the six inputs that determine replay safety.
 *
 * Every field is joined with a NUL separator before hashing. A NUL cannot appear inside any of the
 * six branded inputs — `modelId` rejects control characters, the others are closed enums or fixed-
 * shape hex — so no combination of differently-split field values can collide on the same digest
 * material. Without a separator, a variable-length field (`modelId`) directly adjacent to another
 * variable-length or short field would let two distinct (model, protocol) pairs hash identically.
 */
export function computeKey(
  baseBlob: BlobId,
  headBlob: BlobId,
  ruleDigest: Sha256,
  engineDigest: Sha256,
  model: ModelId,
  proto: Protocol,
): CacheKey {
  const material = [baseBlob, headBlob, ruleDigest, engineDigest, model, proto].join(
    FIELD_SEPARATOR,
  );
  // node:crypto's sha256 hex digest is always exactly 64 lowercase hex characters, so the cast here
  // is not re-validating an untrusted value — it is naming the guaranteed shape of what this
  // process just computed. Contrast `toCacheKey`, which validates a value that came from storage.
  return createHash("sha256").update(material, "utf8").digest("hex") as CacheKey;
}

/**
 * The bound on cross-file context drift between two runs (v0.10.0, issue #50): a digest over the
 * NUL-separated, lexicographically sorted set of every changed path's set-membership token in the
 * pull request's inventory. See this module's top-of-file comment for why this exists and why it
 * hashes path names, never blob content.
 *
 * This function has no notion of what a rename looks like — `memoize.ts`'s caller folds a rename
 * into a single `"<old>-><new>"` token before any token ever reaches here, the same way callers of
 * `computeKey` extract branded field values before calling it. Sorting first makes the result
 * independent of the order `pathTokens` arrived in, matching `git diff`'s own path ordering being
 * an implementation detail this digest must not be sensitive to.
 */
export function computePathSetDigest(pathTokens: readonly string[]): Sha256 {
  const material = [...pathTokens].sort().join(FIELD_SEPARATOR);
  // Same guaranteed-shape reasoning as `computeKey`'s own cast, immediately above: a freshly
  // computed sha256 hex digest is never untrusted input.
  return createHash("sha256").update(material, "utf8").digest("hex") as Sha256;
}

/** One file's replayable review outcome, self-describing via the digests that formed its key. */
export interface CacheEntry {
  readonly key: CacheKey;
  readonly baseBlob: BlobId;
  readonly headBlob: BlobId;
  readonly ruleDigest: Sha256;
  readonly engineDigest: Sha256;
  /**
   * The pull request's whole changed-path-set digest when this entry was written (v0.10.0, issue
   * #50) — deliberately not part of `key`, so a replay must satisfy both independently. See this
   * file's top-of-file comment for the full reasoning.
   */
  readonly prPathSetDigest: Sha256;
  readonly modelId: ModelId;
  readonly protocol: Protocol;
  /** Same shape as `EngineFinding`. An empty list is a real, deliberate negative — not an omission. */
  readonly findings: readonly EngineFinding[];
}

export interface CacheStore {
  readonly schemaVersion: string;
  readonly entries: readonly CacheEntry[];
}

export type CacheStoreRejection =
  | "cache.store.oversized"
  | "cache.store.malformed_json"
  | "cache.store.schema_invalid"
  | "cache.store.entry_overflow"
  | "cache.store.entry_invalid";

export type ReadResult =
  | { readonly ok: true; readonly store: CacheStore }
  | { readonly ok: false; readonly reason: CacheStoreRejection };

function optionalToken(value: unknown, field: string): string | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  const token = asString(value, field, 64);
  if (!/^[a-z][a-z0-9_-]*$/i.test(token)) throw new ValidationError(field);
  return token;
}

const FINDING_REQUIRED = ["path", "content", "startLine", "endLine"] as const;
const FINDING_KEYS = [...FINDING_REQUIRED, "severity", "category"] as const;

function parseFinding(value: unknown, field: string): EngineFinding {
  const object = asObject(value, field);
  requireKeys(object, FINDING_REQUIRED, field);
  rejectUnknownKeys(object, FINDING_KEYS, field);

  const start = asInteger(object.startLine, `${field}.startLine`, 0, PARSE_LIMITS.maxLine);
  const end = asInteger(object.endLine, `${field}.endLine`, 0, PARSE_LIMITS.maxLine);
  if (end < start) throw new ValidationError(`${field}.endLine`);

  return {
    path: repoPath(asString(object.path, `${field}.path`), `${field}.path`),
    content: asString(object.content, `${field}.content`, PARSE_LIMITS.maxFindingContentChars),
    startLine: start,
    endLine: end,
    severity: optionalToken(object.severity, `${field}.severity`),
    category: optionalToken(object.category, `${field}.category`),
  };
}

function parseFindings(value: unknown, field: string): EngineFinding[] {
  return asArray(value, field, PARSE_LIMITS.maxFindingsPerEntry).map((entry, i) =>
    parseFinding(entry, `${field}[${String(i)}]`),
  );
}

const ENTRY_KEYS = [
  "key",
  "baseBlob",
  "headBlob",
  "ruleDigest",
  "engineDigest",
  "prPathSetDigest",
  "modelId",
  "protocol",
  "findings",
] as const;

/**
 * Parses and re-validates one entry, then re-derives its key from its own stored digests.
 *
 * The re-derivation is the point: an entry is self-describing precisely so it does not have to be
 * trusted on the strength of its `key` field alone. A mismatch means the entry is corrupt or was
 * edited by hand, and either way nothing about it can be individually repaired — the caller treats
 * any thrown error here as a reason to discard the whole store, not just this entry.
 */
function parseEntry(value: unknown, index: number): CacheEntry {
  const scope = `store.entries[${String(index)}]`;
  const object = asObject(value, scope);
  requireKeys(object, ENTRY_KEYS, scope);
  rejectUnknownKeys(object, ENTRY_KEYS, scope);

  const base = blobId(asString(object.baseBlob, `${scope}.baseBlob`, 64), `${scope}.baseBlob`);
  const head = blobId(asString(object.headBlob, `${scope}.headBlob`, 64), `${scope}.headBlob`);
  const rule = sha256(
    asString(object.ruleDigest, `${scope}.ruleDigest`, 64),
    `${scope}.ruleDigest`,
  );
  const engine = sha256(
    asString(object.engineDigest, `${scope}.engineDigest`, 64),
    `${scope}.engineDigest`,
  );
  // Validated the same way as `ruleDigest`/`engineDigest` immediately above — a well-formed sha256
  // hex string — but never re-derived: unlike `key`, nothing else in the entry determines what this
  // value should be, since it describes the pull request's state, not this file's own content.
  const pathSet = sha256(
    asString(object.prPathSetDigest, `${scope}.prPathSetDigest`, 64),
    `${scope}.prPathSetDigest`,
  );
  const model = modelId(
    asString(object.modelId, `${scope}.modelId`, PARSE_LIMITS.maxModelIdChars),
    `${scope}.modelId`,
  );
  const proto = protocol(asString(object.protocol, `${scope}.protocol`, 32), `${scope}.protocol`);
  const key = toCacheKey(asString(object.key, `${scope}.key`, 64), `${scope}.key`);

  if (key !== computeKey(base, head, rule, engine, model, proto)) {
    throw new ValidationError(`${scope}.key`);
  }

  return {
    key,
    baseBlob: base,
    headBlob: head,
    ruleDigest: rule,
    engineDigest: engine,
    prPathSetDigest: pathSet,
    modelId: model,
    protocol: proto,
    findings: parseFindings(object.findings, `${scope}.findings`),
  };
}

const STORE_KEYS = ["schemaVersion", "entries"] as const;

function parseStore(value: unknown): CacheStore {
  const object = asObject(value, "store");
  requireKeys(object, STORE_KEYS, "store");
  rejectUnknownKeys(object, STORE_KEYS, "store");

  if (object.schemaVersion !== SUPPORTED_STORE_SCHEMA) {
    throw new ValidationError("store.schemaVersion");
  }
  if (!Array.isArray(object.entries)) throw new ValidationError("store.entries.type");
  if (object.entries.length > PARSE_LIMITS.maxEntries) {
    throw new ValidationError("store.entries.count");
  }

  return {
    schemaVersion: SUPPORTED_STORE_SCHEMA,
    entries: object.entries.map((entry, i) => parseEntry(entry, i)),
  };
}

function classifyRejection(field: string): CacheStoreRejection {
  if (field === "store.entries.count") return "cache.store.entry_overflow";
  if (field.startsWith("store.entries[")) return "cache.store.entry_invalid";
  return "cache.store.schema_invalid";
}

/**
 * Reads a persisted store from hostile input: the text of a file a prior job wrote and a GitHub
 * Actions cache round-tripped through. Any structural problem — truncation, a wrong type anywhere,
 * an oversized document, more entries than the store is allowed to hold, or one entry whose key
 * does not match its own digests — discards the entire store rather than salvaging the entries that
 * did parse. A partially-trusted store is not a safer degraded mode; it is a store whose remaining
 * guarantees no longer hold, since the same corruption or tampering that broke one entry could have
 * broken the boundaries between entries.
 */
export function readStore(text: string): ReadResult {
  if (text.length === 0 || text.length > PARSE_LIMITS.maxStoreBytes) {
    return { ok: false, reason: "cache.store.oversized" };
  }

  let parsed: unknown;
  try {
    parsed = parseJson(text, "store.json");
  } catch {
    return { ok: false, reason: "cache.store.malformed_json" };
  }

  try {
    return { ok: true, store: parseStore(parsed) };
  } catch (error) {
    const field = error instanceof ValidationError ? error.field : "store";
    return { ok: false, reason: classifyRejection(field) };
  }
}

export function lookup(store: CacheStore, key: CacheKey): CacheEntry | undefined {
  return store.entries.find((entry) => entry.key === key);
}

export interface RetentionLimits {
  readonly maxEntries: number;
  readonly maxFindingsPerEntry: number;
}

/** The index of each key's last occurrence, so a repeated key keeps only its most recent value. */
function lastOccurrenceIndexes(entries: readonly CacheEntry[]): ReadonlySet<number> {
  const lastIndexByKey = new Map<CacheKey, number>();
  entries.forEach((entry, index) => lastIndexByKey.set(entry.key, index));
  return new Set(lastIndexByKey.values());
}

/**
 * Merges freshly produced entries into a store, bounding both the per-entry finding count and the
 * total entry count.
 *
 * An incoming entry over `maxFindingsPerEntry` is dropped outright rather than truncated to fit —
 * repairing it by cutting its finding list would silently misreport what the engine actually found,
 * and the entries that were within bounds in the same call are unaffected either way. Any entry
 * whose key already exists in the store — because the same content, rule, engine, and model recurred
 * across two runs — is treated as freshly confirmed and moved to the newest position, so an oldest-
 * first eviction never discards a key this run just revalidated. Eviction removes from the front of
 * the merged list: the array order is itself the recency order, so which entries are "oldest" is
 * never a matter of interpretation.
 */
export function appendEntries(
  store: CacheStore,
  entries: readonly CacheEntry[],
  limits: RetentionLimits,
): CacheStore {
  const admissible = entries.filter((entry) => entry.findings.length <= limits.maxFindingsPerEntry);
  const keep = lastOccurrenceIndexes(admissible);
  const deduped = admissible.filter((_entry, index) => keep.has(index));

  const touchedKeys = new Set(deduped.map((entry) => entry.key));
  const retained = store.entries.filter((entry) => !touchedKeys.has(entry.key));

  const merged = [...retained, ...deduped];
  const bounded =
    merged.length > limits.maxEntries ? merged.slice(merged.length - limits.maxEntries) : merged;

  return { schemaVersion: store.schemaVersion, entries: bounded };
}

function canonicalFinding(finding: EngineFinding): Record<string, unknown> {
  return {
    path: finding.path,
    content: finding.content,
    startLine: finding.startLine,
    endLine: finding.endLine,
    // `JSON.stringify` omits a property whose value is `undefined`, so an absent optional field on
    // read and an omitted one on write are the same representation without any conditional here.
    severity: finding.severity,
    category: finding.category,
  };
}

function canonicalEntry(entry: CacheEntry): Record<string, unknown> {
  return {
    key: entry.key,
    baseBlob: entry.baseBlob,
    headBlob: entry.headBlob,
    ruleDigest: entry.ruleDigest,
    engineDigest: entry.engineDigest,
    prPathSetDigest: entry.prPathSetDigest,
    modelId: entry.modelId,
    protocol: entry.protocol,
    findings: entry.findings.map(canonicalFinding),
  };
}

/**
 * Serializes a store to the exact text `readStore` accepts back.
 *
 * Every entry and finding is rebuilt into an object with a fixed key order before stringifying, so
 * the output depends only on the store's content and never on the property-insertion order of
 * whatever code happened to construct the `CacheEntry` values — the same store serializes to the
 * same bytes regardless of which call path produced it.
 */
export function serializeStore(store: CacheStore): string {
  return JSON.stringify({
    schemaVersion: store.schemaVersion,
    entries: store.entries.map(canonicalEntry),
  });
}
