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
 * three pure functions imported from the shipped product through the same mechanism run.mjs itself
 * uses for `sanitizeFindingBody` — never a re-implementation of `compareContracts`, `describeMismatch`,
 * or `loadReviewProfile`.
 *
 * ## The reality check
 *
 * `compareContracts` pairs interfaces SOLELY by identical name (see its own doc comment and
 * shape-gate.test.ts's "never pairs across different interface names, even with identical member
 * shapes") and only when both sides parse as a "flat" interface: no generics, no `extends`, plain
 * property signatures only. Checked against the actual fixture text in corpus/cases.mjs, NONE of the
 * three named cross-artifact cases currently satisfies that — so the gate fires on none of them
 * today, even though `corpus/profile.json` declares the correct pair for each:
 *
 * - `contract-response-field-dropped` declares `ImportResult` server-side
 *   (src/import-response.ts) and `ImportResponse` client-side (src/import-client.ts) — two
 *   DIFFERENT interface names. `compareContracts` never compares them, by design.
 * - `audit-validator-drift` carries no `export interface` on either side at all: both
 *   scripts/audit-metadata.mjs and src/metadata-store.ts are plain functions. The gate answers a
 *   question about interface shapes; a validator function's internal logic drifting is a different
 *   question, and this fixture is a `.mjs`/`.ts` function pair, not a type-shape pair.
 * - `status-union-widened-consumer-missed`'s changed declaration is `export type CandidateStatus =
 *   ...` — a union of string literals, not an `interface`. `extractFlatInterfaces`'s header pattern
 *   matches only `export interface`, so a `type` alias is invisible to it by construction.
 *
 * None of that is a defect in the gate — every one of the three is exactly the class of input the
 * gate's own header comment says it deliberately, safely skips rather than guesses about. It is a
 * fact about these CORPUS FIXTURES' shape relative to the gate's real reach, pinned here rather than
 * worked around by loosening the gate or rewriting the fixture (out of scope for this file, and
 * explicitly the wrong move even where it is in scope — see shape-gate.ts's own header comment on
 * why a wrong claim from this gate is worse than a missed one). The synthetic fixture below, built
 * the same way, proves the merge mechanism itself — glob match, both-sides git read, compare,
 * render, sanitize — genuinely produces a finding when the two sides actually qualify.
 */

registerTsExtensionHooks();
const { compareContracts, describeMismatch } = await import("../src/contracts/shape-gate.ts");
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
 * rather than imported for the reason in this file's header comment. The load-bearing parts —
 * `compareContracts`, `describeMismatch` — are still the real, imported product functions, never a
 * copy; `pairs` is threaded as a parameter so the tests below can exercise both the real, declared
 * `CONTRACT_PAIRS` and a hand-built synthetic one in the same function.
 */
function computeGateFindings(dir, testCase, pairs) {
  const changed = testCase.files.filter((file) => file.base !== file.head);
  const findings = [];
  for (const pair of pairs) {
    for (const file of changed) {
      if (!pair.matcher.matches(file.path)) continue;
      const left = readAtHead(dir, file.path);
      if (left === undefined) continue;
      for (const counterpart of pair.counterparts) {
        const right = readAtHead(dir, counterpart);
        if (right === undefined) continue;
        for (const mismatch of compareContracts(left, right)) {
          findings.push({
            path: file.path,
            content: describeMismatch(mismatch, file.path, counterpart),
            startLine: 0,
            endLine: 0,
            category: "bug",
            severity: "high",
          });
        }
      }
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
 * `compareContracts`, `describeMismatch`, and a real `sanitizeFindingBody` round trip — genuinely
 * produces a finding when the two sides actually are same-named flat interfaces. Same canonical
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
 * comment. `compareContracts` pairs solely by name, so this produces zero gate findings today, even
 * though the declared pair in `corpus/profile.json` correctly routes the changed file to its
 * counterpart.
 */
test("gate does not fire on contract-response-field-dropped (ImportResult vs ImportResponse: different names)", () => {
  assert.deepEqual(runGate("contract-response-field-dropped"), []);
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
 * interface`, so this is outside the gate's syntax by construction.
 */
test("gate does not fire on status-union-widened-consumer-missed (a type union, not an interface)", () => {
  assert.deepEqual(runGate("status-union-widened-consumer-missed"), []);
});

/**
 * The fourth cross-artifact case (epic #80's same-file variant, Keiko#2977): both halves of the
 * contradiction live in ONE file (a workflow's checkout pin and its `ACTION_PIN` env var), so there
 * is no second file to declare a pair against, and `corpus/profile.json` declares none. Included for
 * completeness: the gate's file-pair mechanism has no way to reach a same-file drift at all, with or
 * without a declared pair.
 */
test("gate produces zero findings for the same-file cross-artifact case (no counterpart file to declare)", () => {
  assert.deepEqual(runGate("pinned-reference-duplicate-desync"), []);
});
