import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { CASES } from "./cases.mjs";
import { FIXED_PATH } from "./fixed-path.mjs";
import { registerTsExtensionHooks } from "./rule-source.mjs";

/**
 * Hermetic coverage for the gap this suite closes: corpus/run.mjs now merges the deterministic
 * cross-artifact gate (`collectGateFindings` / `compareAgainstCounterparts`, src/review.ts) into
 * every case's graded findings, so a corpus run can show the gate closing a case instead of
 * measuring only the engine's half of the product. This file tests that merge directly, rather than
 * through run.mjs: run.mjs is a script with top-level side effects — it checks `OCR_BINARY` and, if
 * present, dispatches the real engine against a real model the instant it is loaded — so it cannot
 * be imported by a hermetic test (the same reason rule-source.mjs was extracted from it).
 *
 * Zero model calls anywhere below: everything here is git plumbing over a throwaway repository plus
 * the gate's own pure functions, imported from the shipped product through the same mechanism
 * run.mjs itself uses for `sanitizeFindingBody` — never a re-implementation of
 * `compareDeclaredContracts`, `findUncoveredUnionMembers`, `detectPinDesync`, their `describe*`
 * renderers, or `loadReviewProfile`.
 *
 * ## The reality check (updated with the v0.13.0 qualification)
 *
 * The paragraphs below once pinned the W5-era gate's reach — `compareContracts` alone — and the
 * v0.13.0 qualification run measured the cost of this file testing THAT reach while run.mjs's merge
 * stayed on the older call set: all three cross-artifact fixtures MISSED in the main run while the
 * product's own wiring (`compareAgainstCounterparts` + `collectPinDesyncFindings`, src/review.ts)
 * would have published every one. Both `computeGateFindings` copies (run.mjs's and this file's) now
 * carry the product's full chain — `compareDeclaredContracts`, `findUncoveredUnionMembers`,
 * `detectPinDesync` — and the tests below assert the FIRING side. The original limits of
 * `compareContracts` alone remain true, remain pinned by shape-gate.test.ts, and are restated below
 * as facts about THAT FUNCTION rather than about the gate as a whole.
 *
 * `compareContracts` pairs interfaces SOLELY by identical name (see its own doc comment and
 * shape-gate.test.ts:469, "never pairs across different interface names, even with identical member
 * shapes") and only when both sides parse as a "flat" interface: no generics, no `extends`, plain
 * property signatures only. Checked against the actual fixture text in corpus/cases.mjs, NONE of the
 * three named cross-artifact cases satisfies what THAT function needs — which is precisely why the
 * chain the product runs has two more members, and why two of the three tests below assert a finding
 * rather than a silence:
 *
 * - `contract-response-field-dropped` declares `ImportResult` server-side
 *   (src/import-response.ts) and `ImportResponse` client-side (src/import-client.ts) — two
 *   DIFFERENT interface names. `compareContracts` never compares them, by design.
 *   `compareDeclaredContracts` does: `corpus/profile.json` names the two files counterparts, so the
 *   positional fallback is the declaration's own meaning, and each side extracts to exactly one flat
 *   interface, leaving no second candidate it could have paired wrong. shape-gate.test.ts:549-595
 *   pins both halves — the fallback firing on this exact shape, and plain `compareContracts` still
 *   finding nothing for the same pair.
 * - `audit-validator-drift` carries no `export interface` on either side at all: both
 *   scripts/audit-metadata.mjs and src/metadata-store.ts are plain functions. The gate answers a
 *   question about interface shapes; a validator function's internal logic drifting is a different
 *   question, and this fixture is a `.mjs`/`.ts` function pair, not a type-shape pair. It is the one
 *   of the three no chain member reaches, and the test below still asserts exactly that.
 * - `status-union-widened-consumer-missed`'s changed declaration is `export type CandidateStatus =
 *   ...` — a union of string literals, not an `interface`. `extractFlatInterfaces`'s header pattern
 *   matches only `export interface`, so a `type` alias is invisible to the INTERFACE comparison by
 *   construction. `findUncoveredUnionMembers` reads the same declaration through
 *   `extractStringUnions` instead, and reports the member head added that the declared counterpart
 *   never mentions as a quoted literal.
 *
 * Where a fixture does not fire, that is not a defect in the gate — it is exactly the class of input
 * the gate's own header comment says it deliberately, safely skips rather than guesses about. Where
 * one does fire, it fires because the review profile DECLARED the pair, never because this gate
 * inferred one. Either way it is a fact about these CORPUS FIXTURES' shape relative to the chain's
 * real reach, pinned here rather than worked around by loosening the gate or rewriting the fixture
 * (out of scope for this file, and explicitly the wrong move even where it is in scope — see
 * shape-gate.ts's own header comment on why a wrong claim from this gate is worse than a missed
 * one). The synthetic fixture below, built the same way, proves the merge mechanism itself — glob
 * match, both-sides git read, compare, render, sanitize — genuinely produces a finding on the strict
 * same-name path too, when the two sides actually qualify for it.
 */

registerTsExtensionHooks();
const { compareDeclaredContracts, describeMismatch, findUncoveredUnionMembers, describeUnionGap } =
  await import("../src/contracts/shape-gate.ts");
const { detectPinDesync, describePinDesync } = await import("../src/contracts/pin-desync.ts");
const { loadReviewProfile } = await import("../src/config/profile.ts");
const { sanitizeFindingBody } = await import("../src/publish/sanitize.ts");
const { GlobSet } = await import("../src/core/glob.ts");

const HERE = dirname(fileURLToPath(import.meta.url));
const COMPILED_PROFILE = loadReviewProfile(readFileSync(join(HERE, "profile.json"), "utf8"));
const CONTRACT_PAIRS = COMPILED_PROFILE.contractPairs ?? [];

function git(args, cwd) {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    env: {
      PATH: FIXED_PATH,
      GIT_AUTHOR_NAME: "corpus",
      GIT_AUTHOR_EMAIL: "corpus@example.test",
      GIT_COMMITTER_NAME: "corpus",
      GIT_COMMITTER_EMAIL: "corpus@example.test",
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_CONFIG_SYSTEM: "/dev/null",
    },
  });
}

function writeTree(dir, files, revision) {
  for (const file of files) {
    const target = join(dir, file.path);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, file[revision]);
  }
}

/**
 * Builds a throwaway repository whose single commit introduces the case's change — a minimal copy
 * of run.mjs's own `buildRepo`, not an import of it; see this file's header comment for why run.mjs
 * cannot be imported here.
 */
function buildRepo(testCase) {
  const dir = mkdtempSync(join(tmpdir(), `kfq-gate-test-${testCase.id}-`));
  git(["init", "-q", "-b", "main"], dir);
  writeTree(dir, testCase.files, "base");
  git(["add", "-A"], dir);
  git(["commit", "-q", "-m", "base", "--no-gpg-sign"], dir);
  writeTree(dir, testCase.files, "head");
  git(["add", "-A"], dir);
  git(["commit", "-q", "-m", "head", "--no-gpg-sign"], dir);
  return dir;
}

/** Mirrors `readTextAtCommit`'s (src/git/plumbing.ts) undefined-on-absence contract. */
function readAtHead(dir, path) {
  try {
    return git(["cat-file", "blob", `HEAD:${path}`], dir);
  } catch {
    return undefined;
  }
}

/**
 * The same merge run.mjs's main loop now performs (`computeGateFindings` there), reimplemented here
 * rather than imported for the reason in this file's header comment. The load-bearing parts — the
 * product's full chain, `compareDeclaredContracts` and `findUncoveredUnionMembers` inside the
 * declared-pair loop, `detectPinDesync` pair-independently after it, plus the three `describe*`
 * renderers — are still the real, imported product functions, never a copy; `pairs` is threaded as a
 * parameter so the tests below can exercise both the real, declared `CONTRACT_PAIRS` and a
 * hand-built synthetic one in the same function.
 */
function computeGateFindings(dir, testCase, pairs) {
  const changed = testCase.files.filter((file) => file.base !== file.head);
  const findings = [];
  const push = (file, content) => {
    findings.push({
      path: file.path,
      content,
      startLine: 0,
      endLine: 0,
      category: "bug",
      severity: "high",
    });
  };
  for (const pair of pairs) {
    for (const file of changed) {
      if (!pair.matcher.matches(file.path)) continue;
      const left = readAtHead(dir, file.path);
      if (left === undefined) continue;
      for (const counterpart of pair.counterparts) {
        const right = readAtHead(dir, counterpart);
        if (right === undefined) continue;
        for (const mismatch of compareDeclaredContracts(left, right)) {
          push(file, describeMismatch(mismatch, file.path, counterpart));
        }
        for (const gap of findUncoveredUnionMembers(file.base, left, right)) {
          push(file, describeUnionGap(gap, file.path, counterpart));
        }
      }
    }
  }
  for (const file of changed) {
    const head = readAtHead(dir, file.path);
    if (head === undefined) continue;
    for (const desync of detectPinDesync(file.base, head)) {
      push(file, describePinDesync(desync, file.path));
    }
  }
  return findings;
}

function findCase(id) {
  const testCase = CASES.find((c) => c.id === id);
  assert.ok(testCase !== undefined, `corpus/cases.mjs must still declare ${id}`);
  return testCase;
}

/** Builds the case's repo, runs the gate against `pairs` (default: the real declared pairs), and
 *  always cleans up — the shape every test below needs, so only the pair and the assertion vary. */
function runGate(id, pairs = CONTRACT_PAIRS) {
  const testCase = findCase(id);
  const dir = buildRepo(testCase);
  try {
    return computeGateFindings(dir, testCase, pairs);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("corpus/profile.json declares exactly the three pairs the named fixtures need", () => {
  assert.equal(CONTRACT_PAIRS.length, 3);
});

/**
 * The positive path: proves the merge mechanism itself — glob match, both-sides git read,
 * `compareDeclaredContracts`'s same-name step (its unchanged `compareContracts` call, run first and
 * answered here, so the positional fallback never runs), `describeMismatch`, and a real
 * `sanitizeFindingBody` round trip — genuinely produces a finding when the two sides actually are
 * same-named flat interfaces. Same canonical
 * shape as src/review.test.ts's own `collectGateFindings` end-to-end test (`ApiShape` declared in
 * `src/server-api.ts` and `src/client-api.ts`), reused deliberately: a reader who knows that test
 * recognizes this as the identical scenario, one layer down, in the harness rather than the product.
 */
test("gate fires exactly once for a genuine same-named flat-interface drift, and the body is publishable", () => {
  const testCase = {
    id: "synthetic-same-named-drift",
    files: [
      {
        path: "src/server-api.ts",
        base: "export interface ApiShape {\n  a: string;\n}\n",
        head: "export interface ApiShape {\n  a: string;\n  b: string;\n}\n",
      },
      {
        // Byte-identical base/head, exactly like the real cross-artifact fixtures: the counterpart
        // never appears in the diff between the two commits either.
        path: "src/client-api.ts",
        base: "export interface ApiShape {\n  a: string;\n}\n",
        head: "export interface ApiShape {\n  a: string;\n}\n",
      },
    ],
  };
  const syntheticPair = {
    matcher: new GlobSet(["src/server-api.ts"]),
    counterparts: ["src/client-api.ts"],
  };

  const dir = buildRepo(testCase);
  let results;
  try {
    results = computeGateFindings(dir, testCase, [syntheticPair]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }

  assert.equal(results.length, 1);
  const [finding] = results;
  assert.equal(finding.path, "src/server-api.ts");
  assert.equal(finding.category, "bug");
  assert.equal(finding.severity, "high");
  assert.equal(finding.startLine, 0);
  assert.equal(finding.endLine, 0);
  assert.ok(finding.content.includes("ApiShape"));
  assert.ok(finding.content.includes("`b`"));
  assert.ok(finding.content.includes("src/client-api.ts"));

  const verdict = sanitizeFindingBody(finding.content);
  assert.equal(verdict.ok, true);
});

test("gate produces zero findings for a case with no declared pair", () => {
  assert.deepEqual(runGate("auth-prefix-compare"), []);
});

/**
 * `contract-response-field-dropped`: `src/import-response.ts` declares `ImportResult`;
 * `src/import-client.ts` declares `ImportResponse`. Different names — see this file's header
 * comment — so what fires is `compareDeclaredContracts`'s positional fallback, not `compareContracts`:
 * `corpus/profile.json` named the two files counterparts, so the positional fallback is the
 * declaration's own meaning. Each side extracts to exactly one flat interface, so there is no second
 * candidate the fallback could have picked wrong, and the finding anchors on the changed file naming
 * the `skippedCount` the client half never gained.
 */
test("declared-pair fallback fires on contract-response-field-dropped (ImportResult vs ImportResponse)", () => {
  const findings = runGate("contract-response-field-dropped");
  assert.equal(findings.length, 1);
  assert.equal(findings[0].path, "src/import-response.ts");
  assert.match(findings[0].content, /skippedCount/);
  assert.equal(sanitizeFindingBody(findings[0].content).ok, true);
});

/**
 * `audit-validator-drift`: neither `scripts/audit-metadata.mjs` nor `src/metadata-store.ts`
 * declares an `export interface` — both sides are plain functions. The gate only ever extracts
 * interfaces, so there is nothing for it to compare here regardless of pairing.
 */
test("gate does not fire on audit-validator-drift (neither side declares an interface)", () => {
  assert.deepEqual(runGate("audit-validator-drift"), []);
});

/**
 * `status-union-widened-consumer-missed`: the changed declaration is `export type CandidateStatus =
 * ...`, a string-literal union, not an `interface`. `extractFlatInterfaces` matches only `export
 * interface`, so the INTERFACE comparison stays silent here — that limit is still true of it alone.
 * `findUncoveredUnionMembers` is what fires: it reads the union through `extractStringUnions` and
 * reports the member head added that the counterpart never mentions as a quoted literal. It runs
 * inside `computeGateFindings`'s declared-pair loop, exactly like the interface comparison, so the
 * profile pair is what routes the changed file to the counterpart the added member is searched for —
 * pair-declared, unlike the pin-desync pass below.
 */
test("union coverage fires on status-union-widened-consumer-missed (the added member is unmentioned)", () => {
  const findings = runGate("status-union-widened-consumer-missed");
  assert.equal(findings.length, 1);
  assert.equal(findings[0].path, "src/candidate-status.ts");
  assert.match(findings[0].content, /rejected/);
  assert.equal(sanitizeFindingBody(findings[0].content).ok, true);
});

/**
 * The fourth cross-artifact case (epic #80's same-file variant, Keiko#2977): both halves of the
 * contradiction live in ONE file (a workflow's checkout pin and its `ACTION_PIN` env var), so there
 * is no second file to declare a pair against, and `corpus/profile.json` declares none.
 * `detectPinDesync` needs none — `computeGateFindings` runs it over every changed file AFTER the
 * pairs loop, comparing that one file's base and head text, which is what "pair-independent" in this
 * test's name means. It is the same split production draws between `collectGateFindings` and
 * `collectPinDesyncFindings` (src/review.ts).
 */
test("pin-desync fires on the same-file cross-artifact case, pair-independent", () => {
  const findings = runGate("pinned-reference-duplicate-desync");
  assert.equal(findings.length, 1);
  assert.equal(findings[0].path, ".github/workflows/review-store.yml");
  assert.match(findings[0].content, /left behind/);
  assert.equal(sanitizeFindingBody(findings[0].content).ok, true);
});
