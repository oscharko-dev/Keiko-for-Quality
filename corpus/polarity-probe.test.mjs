import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { loadTokenizer, overlap, probe } from "./polarity-probe.mjs";

/**
 * Runs the probe against the REAL `similarity.ts`, not a fixture. That is the point: the evidence
 * this pins is a claim about the shipped tokenizer, so a test using a copy of the stopword list
 * would keep passing after the shipped one changed — and the conclusion drawn from it (rule
 * matching must not go through that function) would quietly stop being supported.
 */

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const SOURCE = readFileSync(join(ROOT, "src", "publish", "similarity.ts"), "utf8");
const tokenizer = loadTokenizer(SOURCE);

test("reads the live stopword set rather than a copy of it", () => {
  assert.ok(tokenizer.stopwords.size > 10, "parsed a plausible stopword set");
  assert.equal(tokenizer.stopwords.has("not"), true);
  assert.equal(tokenizer.floor, 3);
});

test("a claim and its exact negation collapse to the same tokens", () => {
  const { pairs } = probe(tokenizer);
  const guard = pairs[0];
  assert.equal(guard.identical, true, "no guard / a guard tokenize identically");
  assert.equal(guard.score, 1);
  // Above MIN_RECURRENCE_SHARED_TOKENS = 8, so the coordinate-free bar fires on opposite meanings.
  assert.ok(guard.shared >= 8, `shared ${String(guard.shared)} clears the recurrence floor`);
});

test("the other two pairs differ only by verb morphology, not by polarity", () => {
  const { pairs } = probe(tokenizer);
  for (const pair of pairs.slice(1)) {
    assert.ok(pair.score >= 0.7, `${pair.negative} scores ${String(pair.score)}`);
  }
});

/**
 * The narrowing a reviewer on Keiko-for-Quality#209 was right to demand: the erasure is real for the
 * `no`/`not` family and is NOT universal. Pinning both halves stops the evidence drifting back to
 * the overstatement.
 */
test("negation survives in `never clears` and is erased in `does not` and `no guard`", () => {
  const { phrases } = probe(tokenizer);
  const byPhrase = new Map(phrases.map((entry) => [entry.phrase, entry.survives]));
  assert.deepEqual(byPhrase.get("does not"), []);
  assert.deepEqual(byPhrase.get("no guard"), ["guard"]);
  assert.deepEqual(byPhrase.get("never clears"), ["never", "clears"]);
});

test("the overlap score saturates on containment, whichever side is smaller", () => {
  const short = tokenizer.tokenize(
    "Do not report unvalidated request headers in the routes module.",
  );
  const long = tokenizer.tokenize(
    "The routes module builds a request with headers copied from the caller, and the module does " +
      "not report a validated length, so a truncated body reaches the handler unvalidated.",
  );
  const result = overlap(short, long);
  assert.equal(result.score, 1, "containment alone gives a perfect score");
  // And the floor is what actually stopped the false fire — not the calibrated 0.70 threshold.
  assert.ok(result.shared < 8, `shared ${String(result.shared)} is below the recurrence floor`);
});
