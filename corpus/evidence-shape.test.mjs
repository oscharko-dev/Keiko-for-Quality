import assert from "node:assert/strict";
import { test } from "node:test";

import { evidenceShapeCounts, statesTriggeringCondition } from "./evidence-shape.mjs";

/**
 * The fixtures below are structural reconstructions of what the two bots actually publish — the
 * sentence shapes, not anyone's code. The predicate exists to reproduce a production measurement
 * (see evidence-shape.mjs), so the cases that matter most are the ones that made the first two
 * attempts at that measurement wrong.
 */

test("a finding that opens on the circumstance states a triggering condition", () => {
  assert.equal(
    statesTriggeringCondition(
      "**Enforce the response cap while streaming**\n\nWhen the peer omits `Content-Length`, " +
        "`response.text()` buffers the whole body before the limit check runs.",
    ),
    true,
  );
  assert.equal(
    statesTriggeringCondition(
      "**Add a request timeout**\n\nIf the server accepts the connection but stalls before " +
        "returning headers, the command blocks until the transport default expires.",
    ),
    true,
  );
});

/**
 * The distinction the predicate rests on, and the reason the sentence anchor is not decoration. A
 * remedy may name a circumstance in passing — "when no injected port is present" — while never
 * saying under what circumstance the code is WRONG. Ours read like this and Codex's do not.
 * Dropping the anchor takes ours from 21.7% to 66.1% and collapses the gap, because it starts
 * counting the circumstance inside the proposed fix as though it were the failing condition.
 */
test("a circumstance named inside the remedy is not the claim opening on a condition", () => {
  assert.equal(
    statesTriggeringCondition(
      "**Restore the route's default connector construction when no injected port is present.** " +
        "This change makes `composeConnectors` depend entirely on `deps.codingContextPorts`.",
    ),
    false,
  );
});

/**
 * The finding that killed the first attempt at this measurement. Scoring "is there a reason" by
 * searching for `because`/`otherwise`/`so that` counted this as unreasoned — it argues from a
 * documented platform behaviour and an allowed caller contract, and simply never uses the word.
 * That heuristic called 53.5% of findings unevidenced, a figure built on phrasing, and a gate on it
 * would have rejected sound work.
 *
 * It is kept as a fixture because the surviving predicate must not repeat the mistake in reverse:
 * this body genuinely does NOT open on a condition, and scoring it `false` is correct and narrow —
 * it says the shape is absent, never that the finding is wrong.
 */
test("an argued finding that never states its circumstance is scored absent, not wrong", () => {
  const body =
    '**Allow `=` in the base64url cursor validation.** `Buffer#toString("base64url")` can ' +
    "produce padded output on some runtimes and callers are allowed to send it back verbatim, " +
    "so the cursor is rejected on a value this API issued.";
  assert.equal(statesTriggeringCondition(body), false);
});

/**
 * The second discarded attempt, pinned so it is not rebuilt. A "states the consequence" predicate
 * scored ours 23.0% against Codex's 40.5% — until one extra causal form (`, so <clause>`, which the
 * fixture above uses) moved both to 66.9% and 71.8%. A 17.5pp gap that becomes 4.9pp on a synonym
 * was measuring house style. The condition predicate survived the same treatment (41.4pp anchored,
 * 38.5pp on `When`/`If` alone, 40.0pp with more keywords), which is why it is the only one here.
 */
test("the module exposes one graded predicate, not a suite of fragile ones", async () => {
  const module = await import("./evidence-shape.mjs");
  assert.deepEqual(Object.keys(module).sort(), [
    "evidenceShapeCounts",
    "statesTriggeringCondition",
  ]);
});

/** Collapsed agent blocks, markers and fenced code are furniture, never the argument. */
test("the collapsed agent block and fenced code do not lend a finding a shape it lacks", () => {
  const body =
    "**Rename the helper.** This change renames `foo` to `bar`.\n\n" +
    "```diff\n- if (x) { return }\n```\n\n" +
    "<details><summary>Prompt</summary>When acting on this, verify it first.</details>\n" +
    "<!-- marker -->";
  assert.equal(statesTriggeringCondition(body), false);
});

test("counts summarise a set without re-deriving the predicate", () => {
  const counts = evidenceShapeCounts([
    "When the cache is cold, the handler recomputes every entry.",
    "If the token expires, the retry loop spins.",
    "This change renames the helper.",
  ]);
  assert.deepEqual(counts, { findings: 3, withCondition: 2 });
});

test("an absent or empty body is scored, not thrown on", () => {
  assert.equal(statesTriggeringCondition(undefined), false);
  assert.equal(statesTriggeringCondition(null), false);
  assert.equal(statesTriggeringCondition(""), false);
});
