import { describe, expect, it } from "vitest";

import { sha256, type Sha256 } from "../core/brands.js";
import type { EngineFinding } from "../engine/result.js";
import {
  PARSE_LIMITS,
  SUPPORTED_STORE_SCHEMA,
  appendEntries,
  blobId,
  byCodeUnit,
  computeKey,
  computePathSetDigest,
  lookup,
  modelId,
  entriesUnderCurrentSemantics,
  protocol,
  readStore,
  serializeStore,
  type BlobId,
  type CacheEntry,
  type CacheKey,
  type CacheStore,
  type ModelId,
  type Protocol,
  PUBLICATION_SEMANTICS,
} from "./review-cache.js";

const BASE_BLOB = blobId("a".repeat(40));
const HEAD_BLOB = blobId("b".repeat(40));
const RULE_DIGEST: Sha256 = sha256("1".repeat(64));
const ENGINE_DIGEST: Sha256 = sha256("2".repeat(64));
const MODEL_ID = modelId("claude-sonnet-4-5");
const PROTOCOL = protocol("anthropic");
// An arbitrary but fixed changed-path-set digest (v0.10.0, issue #50). Its actual value is never
// the point in this file — only `memoize.test.ts` exercises path-set semantics — so every fixture
// below shares this one constant unless a test overrides it explicitly.
const PATH_SET_DIGEST: Sha256 = sha256("5".repeat(64));

interface Inputs {
  readonly base: BlobId;
  readonly head: BlobId;
  readonly rule: Sha256;
  readonly engine: Sha256;
  readonly model: ModelId;
  readonly proto: Protocol;
}

function baseline(): Inputs {
  return {
    base: BASE_BLOB,
    head: HEAD_BLOB,
    rule: RULE_DIGEST,
    engine: ENGINE_DIGEST,
    model: MODEL_ID,
    proto: PROTOCOL,
  };
}

function keyFor(inputs: Inputs): CacheKey {
  return computeKey(
    inputs.base,
    inputs.head,
    inputs.rule,
    inputs.engine,
    inputs.model,
    inputs.proto,
  );
}

function finding(overrides: Partial<EngineFinding> = {}): EngineFinding {
  return {
    path: "src/a.ts" as EngineFinding["path"],
    content: "This leaks the handle on the error path.",
    startLine: 10,
    endLine: 12,
    severity: "high",
    category: "bug",
    ...overrides,
  };
}

function entryFor(
  inputs: Inputs,
  findings: readonly EngineFinding[],
  pathSetDigest: Sha256 = PATH_SET_DIGEST,
): CacheEntry {
  return {
    key: keyFor(inputs),
    baseBlob: inputs.base,
    headBlob: inputs.head,
    ruleDigest: inputs.rule,
    engineDigest: inputs.engine,
    prPathSetDigest: pathSetDigest,
    semantics: PUBLICATION_SEMANTICS,
    modelId: inputs.model,
    protocol: inputs.proto,
    findings,
  };
}

const EMPTY_STORE: CacheStore = { schemaVersion: SUPPORTED_STORE_SCHEMA, entries: [] };

describe("computeKey", () => {
  it("is a 64-character lowercase hex digest", () => {
    const key = keyFor(baseline());
    expect(key).toMatch(/^[0-9a-f]{64}$/);
  });

  it("is stable for identical inputs", () => {
    expect(keyFor(baseline())).toBe(keyFor(baseline()));
  });

  it.each([
    ["baseBlob", (i: Inputs): Inputs => ({ ...i, base: blobId("c".repeat(40)) })],
    ["headBlob", (i: Inputs): Inputs => ({ ...i, head: blobId("d".repeat(40)) })],
    ["ruleDigest", (i: Inputs): Inputs => ({ ...i, rule: sha256("3".repeat(64)) })],
    ["engineDigest", (i: Inputs): Inputs => ({ ...i, engine: sha256("4".repeat(64)) })],
    ["modelId", (i: Inputs): Inputs => ({ ...i, model: modelId("gpt-5") })],
    ["protocol", (i: Inputs): Inputs => ({ ...i, proto: protocol("openai") })],
  ])("changes when %s changes and nothing else does", (_name, mutate) => {
    const before = keyFor(baseline());
    const after = keyFor(mutate(baseline()));
    expect(after).not.toBe(before);
  });

  it("does not let a variable-length model id collide with an adjacent protocol boundary", () => {
    // Guards the NUL-separator reasoning in computeKey's own doc comment: without a delimiter,
    // model="ab" + protocol="c"-shaped material could coincide with model="a" + protocol="bc"-shaped
    // material for some pair of values. Two different splits of the same total content must not
    // produce the same key.
    const a = keyFor({ ...baseline(), model: modelId("openaix"), proto: protocol("anthropic") });
    const b = keyFor({ ...baseline(), model: modelId("openai"), proto: protocol("anthropic") });
    expect(a).not.toBe(b);
  });
});

describe("lookup", () => {
  it("finds an entry by its exact key", () => {
    const entry = entryFor(baseline(), []);
    const store: CacheStore = { schemaVersion: SUPPORTED_STORE_SCHEMA, entries: [entry] };
    expect(lookup(store, entry.key)).toEqual(entry);
  });

  it("returns undefined for a key that is not present", () => {
    const entry = entryFor(baseline(), []);
    const store: CacheStore = { schemaVersion: SUPPORTED_STORE_SCHEMA, entries: [entry] };
    const otherKey = keyFor({ ...baseline(), model: modelId("gpt-5") });
    expect(lookup(store, otherKey)).toBeUndefined();
  });
});

describe("negative entries round-trip", () => {
  it("preserves an empty finding list through append, serialize, and read", () => {
    const entry = entryFor(baseline(), []);
    const appended = appendEntries(EMPTY_STORE, [entry], {
      maxEntries: 10,
      maxFindingsPerEntry: 10,
    });
    const text = serializeStore(appended);

    const result = readStore(text);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const readBack = lookup(result.store, entry.key);
    expect(readBack?.findings).toEqual([]);
  });

  it("preserves a non-empty finding list through the same path", () => {
    const entry = entryFor(baseline(), [finding()]);
    const appended = appendEntries(EMPTY_STORE, [entry], {
      maxEntries: 10,
      maxFindingsPerEntry: 10,
    });
    const result = readStore(serializeStore(appended));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(lookup(result.store, entry.key)?.findings).toEqual([finding()]);
  });
});

describe("appendEntries", () => {
  it("drops an entry whose finding count exceeds the limit but keeps the others", () => {
    const overBudget = entryFor(baseline(), [finding(), finding(), finding()]);
    const withinBudget = entryFor({ ...baseline(), model: modelId("gpt-5") }, [finding()]);
    const result = appendEntries(EMPTY_STORE, [overBudget, withinBudget], {
      maxEntries: 10,
      maxFindingsPerEntry: 2,
    });
    expect(result.entries.map((e) => e.key)).toEqual([withinBudget.key]);
  });

  it("evicts the oldest entries first, deterministically, once maxEntries is exceeded", () => {
    const a = entryFor({ ...baseline(), model: modelId("model-a") }, []);
    const b = entryFor({ ...baseline(), model: modelId("model-b") }, []);
    const c = entryFor({ ...baseline(), model: modelId("model-c") }, []);

    const afterA = appendEntries(EMPTY_STORE, [a], { maxEntries: 2, maxFindingsPerEntry: 10 });
    const afterB = appendEntries(afterA, [b], { maxEntries: 2, maxFindingsPerEntry: 10 });
    const afterC = appendEntries(afterB, [c], { maxEntries: 2, maxFindingsPerEntry: 10 });

    expect(afterC.entries.map((e) => e.key)).toEqual([b.key, c.key]);
  });

  it("touches an existing key to the newest position instead of duplicating it", () => {
    const a = entryFor({ ...baseline(), model: modelId("model-a") }, []);
    const b = entryFor({ ...baseline(), model: modelId("model-b") }, []);

    const seeded = appendEntries(EMPTY_STORE, [a, b], { maxEntries: 10, maxFindingsPerEntry: 10 });
    // Re-append `a`: same content pair, rule, engine, model, and protocol recurred in a later run.
    const touched = appendEntries(seeded, [a], { maxEntries: 10, maxFindingsPerEntry: 10 });

    expect(touched.entries.map((e) => e.key)).toEqual([b.key, a.key]);
    expect(touched.entries).toHaveLength(2);
  });

  it("deduplicates multiple occurrences of the same key within one call, keeping the last", () => {
    const first = entryFor(baseline(), [finding({ content: "first" })]);
    const second = entryFor(baseline(), [finding({ content: "second" })]);
    const result = appendEntries(EMPTY_STORE, [first, second], {
      maxEntries: 10,
      maxFindingsPerEntry: 10,
    });
    expect(result.entries).toHaveLength(1);
    expect(result.entries[0]?.findings[0]?.content).toBe("second");
  });

  it("evicts even when a single call supplies more entries than maxEntries allows", () => {
    const a = entryFor({ ...baseline(), model: modelId("model-a") }, []);
    const b = entryFor({ ...baseline(), model: modelId("model-b") }, []);
    const c = entryFor({ ...baseline(), model: modelId("model-c") }, []);
    const result = appendEntries(EMPTY_STORE, [a, b, c], {
      maxEntries: 1,
      maxFindingsPerEntry: 10,
    });
    expect(result.entries.map((e) => e.key)).toEqual([c.key]);
  });

  // The store-size cliff (v0.11.0): `maxEntries` alone bounds entry COUNT, not the bytes those
  // entries serialize to. A count limit generous enough to be useless as a byte bound (as
  // `maxEntries` — 20,000 — is against `maxFindingsPerEntry`-sized entries) can write a store
  // `readStore` rejects WHOLE on the very next run. These use entries large enough, in far fewer
  // than 20,000 of them, to cross `maxStoreBytes` on their own — isolating the byte bound from the
  // pre-existing count bound, which stays far out of reach (`PARSE_LIMITS.maxEntries`) throughout.
  describe("appendEntries: the byte-size cliff", () => {
    // Each entry's single finding is right at `maxFindingContentChars`, so every entry serializes
    // to a little over 20 KB — comfortably crossing the 4 MiB store ceiling in the low hundreds of
    // entries rather than needing anywhere near `maxEntries` (20,000) of them.
    function bigEntry(model: string): CacheEntry {
      return entryFor({ ...baseline(), model: modelId(model) }, [
        finding({ content: "x".repeat(PARSE_LIMITS.maxFindingContentChars) }),
      ]);
    }

    const RETENTION = {
      maxEntries: PARSE_LIMITS.maxEntries,
      maxFindingsPerEntry: PARSE_LIMITS.maxFindingsPerEntry,
    };

    it("evicts oldest entries so an append that would cross maxStoreBytes still parses back through the real reader", () => {
      const fresh = Array.from({ length: 260 }, (_unused, i) => bigEntry(`model-${String(i)}`));
      const result = appendEntries(EMPTY_STORE, fresh, RETENTION);

      // 260 entries at ~20 KB each is well past 4 MiB uncapped — eviction must have happened.
      expect(result.entries.length).toBeLessThan(fresh.length);

      const text = serializeStore(result);
      expect(text.length).toBeLessThanOrEqual(PARSE_LIMITS.maxStoreBytes);

      // The real production reader, not a re-statement of its size rule: this is the guarantee
      // that actually matters — a store `appendEntries` is willing to write must be one the very
      // next run can read back, or the cliff this fix closes reopens silently.
      const read = readStore(text);
      expect(read.ok).toBe(true);
    });

    it("keeps the newest entries, in their original relative order, when evicting for byte size", () => {
      const fresh = Array.from({ length: 260 }, (_unused, i) => bigEntry(`model-${String(i)}`));
      const result = appendEntries(EMPTY_STORE, fresh, RETENTION);

      const survivingKeys = result.entries.map((e) => e.key);
      const inputKeys = fresh.map((e) => e.key);
      const tailStart = inputKeys.length - survivingKeys.length;

      // Survivors are a contiguous SUFFIX of the input — oldest-first eviction only, never a gap
      // torn out of the middle — and the very last (newest) entry appended is always among them.
      expect(survivingKeys).toEqual(inputKeys.slice(tailStart));
      expect(result.entries.at(-1)?.key).toBe(fresh[fresh.length - 1]?.key);
    });

    it("leaves a store already within budget untouched by the byte bound", () => {
      const small = [entryFor(baseline(), [finding()])];
      const result = appendEntries(EMPTY_STORE, small, RETENTION);
      expect(result.entries.map((e) => e.key)).toEqual(small.map((e) => e.key));
    });
  });
});

describe("serializeStore", () => {
  it("is stable regardless of the property order the entry was constructed with", () => {
    const entry = entryFor(baseline(), [finding()]);
    const reordered: CacheEntry = {
      findings: entry.findings,
      protocol: entry.protocol,
      modelId: entry.modelId,
      prPathSetDigest: entry.prPathSetDigest,
      semantics: PUBLICATION_SEMANTICS,
      engineDigest: entry.engineDigest,
      ruleDigest: entry.ruleDigest,
      headBlob: entry.headBlob,
      baseBlob: entry.baseBlob,
      key: entry.key,
    };

    const canonical = serializeStore({ schemaVersion: SUPPORTED_STORE_SCHEMA, entries: [entry] });
    const fromReordered = serializeStore({
      schemaVersion: SUPPORTED_STORE_SCHEMA,
      entries: [reordered],
    });
    expect(fromReordered).toBe(canonical);
  });

  it("produces identical output across repeated calls on the same store", () => {
    const entry = entryFor(baseline(), [finding()]);
    const store: CacheStore = { schemaVersion: SUPPORTED_STORE_SCHEMA, entries: [entry] };
    expect(serializeStore(store)).toBe(serializeStore(store));
  });

  it("omits absent optional finding fields rather than writing null", () => {
    const entry = entryFor(baseline(), [finding({ severity: undefined, category: undefined })]);
    const text = serializeStore({ schemaVersion: SUPPORTED_STORE_SCHEMA, entries: [entry] });
    expect(text).not.toContain("severity");
    expect(text).not.toContain("category");
  });
});

describe("readStore: malformed input is rejected whole", () => {
  it("rejects truncated JSON", () => {
    const result = readStore('{"schemaVersion": "keiko-for-quality.review-cache/v1", "entries": [');
    expect(result).toEqual({ ok: false, reason: "cache.store.malformed_json" });
  });

  it("rejects an empty document", () => {
    expect(readStore("")).toEqual({ ok: false, reason: "cache.store.oversized" });
  });

  it("rejects an oversized document without attempting to parse it", () => {
    const oversized = "a".repeat(PARSE_LIMITS.maxStoreBytes + 1);
    expect(readStore(oversized)).toEqual({ ok: false, reason: "cache.store.oversized" });
  });

  it("rejects a document whose entries field is the wrong type", () => {
    const text = JSON.stringify({ schemaVersion: SUPPORTED_STORE_SCHEMA, entries: "nope" });
    expect(readStore(text)).toEqual({ ok: false, reason: "cache.store.schema_invalid" });
  });

  it("rejects an unrecognised schema version", () => {
    const text = JSON.stringify({ schemaVersion: "something-else/v9", entries: [] });
    expect(readStore(text)).toEqual({ ok: false, reason: "cache.store.schema_invalid" });
  });

  it("rejects a store still carrying the retired v1 schema marker (no migration, v0.10.0 issue #50)", () => {
    // v1 predates `prPathSetDigest`. There is deliberately no migration path: a store written under
    // it fails this exact-match check like any other unrecognised schema, and the run starts from
    // an empty store rather than trying to interpret v1 entries as v2 ones.
    const text = JSON.stringify({
      schemaVersion: "keiko-for-quality.review-cache/v1",
      entries: [],
    });
    expect(readStore(text)).toEqual({ ok: false, reason: "cache.store.schema_invalid" });
  });

  it("rejects a document with more entries than the parser allows", () => {
    const tooMany = Array.from({ length: PARSE_LIMITS.maxEntries + 1 }, () => ({}));
    const text = JSON.stringify({ schemaVersion: SUPPORTED_STORE_SCHEMA, entries: tooMany });
    expect(readStore(text)).toEqual({ ok: false, reason: "cache.store.entry_overflow" });
  });

  it("rejects the whole store when one entry's key does not match its own digests", () => {
    const good = entryFor(baseline(), [finding()]);
    const tamperedGood = { ...good, key: keyFor({ ...baseline(), model: modelId("gpt-5") }) };
    const store: CacheStore = { schemaVersion: SUPPORTED_STORE_SCHEMA, entries: [tamperedGood] };
    const result = readStore(serializeStore(store));
    expect(result).toEqual({ ok: false, reason: "cache.store.entry_invalid" });
  });

  it("discards every entry, not just the bad one, when a store mixes good and bad entries", () => {
    const good = entryFor(baseline(), []);
    const otherGood = entryFor({ ...baseline(), model: modelId("gpt-5") }, []);
    const store: CacheStore = {
      schemaVersion: SUPPORTED_STORE_SCHEMA,
      entries: [good, otherGood],
    };
    const text = serializeStore(store);
    // Corrupt only the second entry's digest field directly in the serialized JSON.
    const parsed = JSON.parse(text) as { entries: Record<string, unknown>[] };
    const secondEntry = parsed.entries[1];
    if (secondEntry === undefined) throw new Error("fixture invariant violated");
    secondEntry.ruleDigest = "f".repeat(64);
    const result = readStore(JSON.stringify(parsed));
    expect(result.ok).toBe(false);
  });

  it("rejects an entry with an unrecognised extra field", () => {
    const good = entryFor(baseline(), []);
    const text = serializeStore({ schemaVersion: SUPPORTED_STORE_SCHEMA, entries: [good] });
    const parsed = JSON.parse(text) as { entries: Record<string, unknown>[] };
    const onlyEntry = parsed.entries[0];
    if (onlyEntry === undefined) throw new Error("fixture invariant violated");
    onlyEntry.unexpected = "surprise";
    const result = readStore(JSON.stringify(parsed));
    expect(result).toEqual({ ok: false, reason: "cache.store.entry_invalid" });
  });

  it("accepts a well-formed, empty store", () => {
    const text = serializeStore(EMPTY_STORE);
    const result = readStore(text);
    expect(result).toEqual({ ok: true, store: EMPTY_STORE });
  });
});

describe("readStore: a tampered prPathSetDigest is rejected whole (v0.10.0, issue #50)", () => {
  function withTamperedPathSetDigest(value: unknown): string {
    const good = entryFor(baseline(), []);
    const text = serializeStore({ schemaVersion: SUPPORTED_STORE_SCHEMA, entries: [good] });
    const parsed = JSON.parse(text) as { entries: Record<string, unknown>[] };
    const onlyEntry = parsed.entries[0];
    if (onlyEntry === undefined) throw new Error("fixture invariant violated");
    onlyEntry.prPathSetDigest = value;
    return JSON.stringify(parsed);
  }

  // Matches this parser's existing policy for every other stored digest (`ruleDigest`,
  // `engineDigest`): any structural problem discards the whole store, not just the one entry.
  it.each([
    ["the wrong length", "abc123"],
    ["non-hex characters", "g".repeat(64)],
    ["an empty string", ""],
    ["unicode", "🙂".repeat(20)],
  ])("rejects the whole store when prPathSetDigest has %s", (_name, bad) => {
    const result = readStore(withTamperedPathSetDigest(bad));
    expect(result).toEqual({ ok: false, reason: "cache.store.entry_invalid" });
  });

  it("rejects the whole store when prPathSetDigest is missing entirely", () => {
    const good = entryFor(baseline(), []);
    const text = serializeStore({ schemaVersion: SUPPORTED_STORE_SCHEMA, entries: [good] });
    const parsed = JSON.parse(text) as { entries: Record<string, unknown>[] };
    const onlyEntry = parsed.entries[0];
    if (onlyEntry === undefined) throw new Error("fixture invariant violated");
    delete onlyEntry.prPathSetDigest;
    const result = readStore(JSON.stringify(parsed));
    expect(result).toEqual({ ok: false, reason: "cache.store.entry_invalid" });
  });
});

describe("computePathSetDigest", () => {
  it("is a 64-character lowercase hex digest", () => {
    expect(computePathSetDigest(["src/a.ts"])).toMatch(/^[0-9a-f]{64}$/);
  });

  it("is stable for identical inputs", () => {
    expect(computePathSetDigest(["src/a.ts", "src/b.ts"])).toBe(
      computePathSetDigest(["src/a.ts", "src/b.ts"]),
    );
  });

  it("does not depend on the order tokens arrive in", () => {
    expect(computePathSetDigest(["c", "a", "b"])).toBe(computePathSetDigest(["a", "b", "c"]));
  });

  it("changes when a path is added", () => {
    expect(computePathSetDigest(["a", "b"])).not.toBe(computePathSetDigest(["a", "b", "c"]));
  });

  it("changes when a path is removed", () => {
    expect(computePathSetDigest(["a", "b", "c"])).not.toBe(computePathSetDigest(["a", "b"]));
  });

  it("is well-defined for an empty set", () => {
    expect(computePathSetDigest([])).toMatch(/^[0-9a-f]{64}$/);
  });

  it("does not let two tokens split differently collide, mirroring computeKey's own NUL-safety", () => {
    expect(computePathSetDigest(["ab", "c"])).not.toBe(computePathSetDigest(["a", "bc"]));
  });
});

describe("byCodeUnit", () => {
  // Sonar (typescript:S2871) flags a bare, argument-less `.sort()` on a string array and suggests
  // `String.prototype.localeCompare`. That suggestion is wrong for this call site specifically:
  // `computePathSetDigest`'s ordering feeds a content digest that must come out identical on every
  // runner a store's Actions cache entry might be restored on, and `localeCompare` collates by the
  // runtime's default locale, which is not guaranteed to agree across machines. These tests pin the
  // actual (correct) choice — plain code-unit order — directly, rather than through a digest a
  // future reader could not tell was locale-sensitive or not just by reading the assertion.
  it("orders lexicographically by code unit", () => {
    expect(byCodeUnit("a", "b")).toBeLessThan(0);
    expect(byCodeUnit("b", "a")).toBeGreaterThan(0);
    expect(byCodeUnit("a", "a")).toBe(0);
  });

  it("sorts every uppercase ASCII letter before every lowercase one", () => {
    // Code-unit order: "A" is 0x41, "a" is 0x61. Many locale collations invert this pair, which is
    // exactly the divergence this pin exists to catch if a future edit switched to `localeCompare`.
    expect(byCodeUnit("B", "a")).toBeLessThan(0);
    expect(["a", "B"].sort(byCodeUnit)).toEqual(["B", "a"]);
  });
});

describe("branded input validators", () => {
  it("rejects a blob id of the wrong length", () => {
    expect(() => blobId("abc123")).toThrow();
  });

  it("normalizes blob id case", () => {
    expect(blobId("A".repeat(40))).toBe("a".repeat(40));
  });

  it("rejects an empty model id", () => {
    expect(() => modelId("")).toThrow();
  });

  it("rejects a model id containing a control character", () => {
    expect(() => modelId(`gpt${String.fromCodePoint(0)}5`)).toThrow();
  });

  it("rejects a protocol outside the closed set", () => {
    expect(() => protocol("grpc")).toThrow();
  });
});

describe("entriesUnderCurrentSemantics", () => {
  /**
   * The behaviour the whole v3 schema exists for. Before it, the consumer partitioned the store by
   * the action's commit sha, so every release discarded every entry of every open pull request —
   * measured on the live consumer as four pins in 33 hours against a 9% hit rate on large runs. The
   * cost of that coarseness is what this keeps: a release that did not touch publication now keeps
   * the week of entries a long-running pull request accumulated.
   */
  it("keeps the entries this build's publication contract wrote", () => {
    const entry = entryFor(baseline(), []);
    const store: CacheStore = { schemaVersion: SUPPORTED_STORE_SCHEMA, entries: [entry] };

    expect(entriesUnderCurrentSemantics(store)).toEqual(store);
  });

  /**
   * And the half that makes keeping the rest safe. A finding list written under an older sanitizer
   * may contain a body this build refuses to publish — v0.15.0's diff-echo rejection is the worked
   * example — so replaying it would post something the current sanitizer already rejected once.
   */
  it("drops an entry another publication contract wrote, and only that entry", () => {
    const mine = entryFor(baseline(), []);
    const theirs: CacheEntry = {
      ...entryFor({ ...baseline(), base: blobId("c".repeat(40)) }, []),
      semantics: "v0.14.0-whatever",
    };
    const store: CacheStore = { schemaVersion: SUPPORTED_STORE_SCHEMA, entries: [mine, theirs] };

    const usable = entriesUnderCurrentSemantics(store);

    expect(usable.entries).toEqual([mine]);
    expect(usable.schemaVersion).toBe(SUPPORTED_STORE_SCHEMA);
  });

  /**
   * A store nothing was retired from must come back as the same object: `loadCacheStore` reports the
   * difference between the two lengths as `retired`, and an allocation that changed nothing would
   * make an ordinary run look like it had paid for a release it did not.
   */
  it("returns the store unchanged when every entry belongs to this build", () => {
    const store: CacheStore = {
      schemaVersion: SUPPORTED_STORE_SCHEMA,
      entries: [
        entryFor(baseline(), []),
        entryFor({ ...baseline(), base: blobId("c".repeat(40)) }, []),
      ],
    };

    expect(entriesUnderCurrentSemantics(store)).toBe(store);
  });

  /**
   * The round trip the field has to survive to be worth storing: written, serialized, read back,
   * still recognised. `parseEntry` re-derives `key` from the entry's own digests but deliberately
   * does not re-derive this — nothing in the entry's content determines which wrapper wrote it.
   */
  it("survives serialization and is honoured on the way back in", () => {
    const store: CacheStore = {
      schemaVersion: SUPPORTED_STORE_SCHEMA,
      entries: [
        entryFor(baseline(), []),
        {
          ...entryFor({ ...baseline(), base: blobId("c".repeat(40)) }, []),
          semantics: "v0.14.0-old",
        },
      ],
    };

    const result = readStore(serializeStore(store));

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("unreachable");
    expect(result.store.entries).toHaveLength(2);
    expect(entriesUnderCurrentSemantics(result.store).entries).toHaveLength(1);
  });

  /** An entry with no `semantics` at all is a v2 store's shape, and v2 is not read at all. */
  it("refuses a store whose entries predate the field", () => {
    const legacy = JSON.stringify({
      schemaVersion: "keiko-for-quality.review-cache/v2",
      entries: [],
    });

    const result = readStore(legacy);

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.reason).toBe("cache.store.schema_invalid");
  });
});
