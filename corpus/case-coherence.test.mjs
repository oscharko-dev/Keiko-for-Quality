import assert from "node:assert/strict";
import { test } from "node:test";

import { CASES } from "./cases.mjs";

/**
 * A case's fixture must be a repository state a real pull request could arrive in. The corpus grades
 * what the reviewer does with a diff, and the reviewer is allowed to read the rest of the repository
 * to judge it — so a file the change references but the fixture never commits is not a smaller
 * fixture, it is a different experiment.
 *
 * The measurement that produced this file: `clean-added-test` carried only `src/ratio.test.ts`, and
 * the added assertion (`ratio(1, 0)` throws RangeError) can only be judged against `src/ratio.ts`.
 * The reviewer went to read it, git answered `path 'src/ratio.ts' does not exist in 'HEAD'`, and the
 * engine spent ~24 tool calls and ~195k tokens before exiting non-zero. 2 of 8 runs passed on the
 * v0.15.0 tree, and only when the model happened not to ask. The case was never measuring "does the
 * reviewer stay silent on a strengthened test suite"; it was measuring an impossible repository.
 *
 * The rule enforced here is deliberately narrow — a `*.test.ts` whose module sits at the sibling
 * path — because that is the pairing the measurement covers. It is a shape check, not a general
 * import resolver: no corpus case should need one, and a case that does is telling you it has grown
 * too large to grade.
 */

/**
 * The six cases that carry the shape and are left alone on purpose. Their verdict is decidable from
 * the diff itself — every seeded one hides its defect INSIDE the test file — so none has ever
 * spiralled the way `clean-added-test` did. They stay listed rather than fixed because a fixture is
 * a recorded measurement basis: re-cutting six of them on suspicion, with no failing run to point
 * at, would discard comparability against every qualification already in `corpus/evidence/` and buy
 * nothing. A case that starts failing here earns its fix with evidence, exactly as this one did.
 */
const MODULE_OMITTED_ON_PURPOSE = new Set([
  "weakened-assertion",
  "redaction-assertion-loosened",
  "stale-session-after-refresh",
  "clean-test-asserts-the-opposite",
  "clean-reset-modules-is-load-bearing",
  "budget-starved-clean-neighbours",
]);

function modulesMissingFrom(testCase) {
  const paths = new Set(testCase.files.map((file) => file.path));
  return [...paths]
    .filter((path) => path.endsWith(".test.ts"))
    .map((path) => path.replace(/\.test\.ts$/u, ".ts"))
    .filter((modulePath) => !paths.has(modulePath));
}

test("a test file's module is committed alongside it, or the omission is recorded", () => {
  const unlisted = CASES.filter(
    (testCase) =>
      modulesMissingFrom(testCase).length > 0 && !MODULE_OMITTED_ON_PURPOSE.has(testCase.id),
  ).map((testCase) => `${testCase.id} (missing ${modulesMissingFrom(testCase).join(", ")})`);

  assert.deepEqual(
    unlisted,
    [],
    "a case tests a module its fixture never commits — the reviewer will try to read it and git " +
      "will answer 'does not exist in HEAD'. Commit the module as unchanged context " +
      "(base === head keeps it out of the diff), or add the id to MODULE_OMITTED_ON_PURPOSE with " +
      "the reason its verdict is decidable from the diff alone.",
  );
});

/**
 * The allowlist is a record of measured cases, not a mute button: an id that no longer needs to be
 * there has to leave, or the next omission hides behind a stale entry.
 */
test("every recorded omission still describes a real case that still omits its module", () => {
  const byId = new Map(CASES.map((testCase) => [testCase.id, testCase]));
  for (const id of MODULE_OMITTED_ON_PURPOSE) {
    const testCase = byId.get(id);
    assert.ok(
      testCase !== undefined,
      `MODULE_OMITTED_ON_PURPOSE names a case that no longer exists: ${id}`,
    );
    assert.ok(
      modulesMissingFrom(testCase).length > 0,
      `${id} now commits its module — drop it from MODULE_OMITTED_ON_PURPOSE`,
    );
  }
});

/**
 * The fix's own mechanism, pinned: context files earn their place by being identical at both
 * revisions. `writeTree` (corpus/run.mjs) writes every file at base and again at head, so an
 * identical pair is committed twice and produces no hunk — the module is readable at HEAD and the
 * graded diff still contains only the change the case is about. A future edit that touched only one
 * side would silently turn context into a second changed file and re-point what the case measures.
 */
test("clean-added-test's module is context, not part of the change", () => {
  const testCase = CASES.find((entry) => entry.id === "clean-added-test");
  const moduleFile = testCase.files.find((file) => file.path === "src/ratio.ts");

  assert.ok(moduleFile !== undefined, "the module under test must be committed with the case");
  assert.equal(
    moduleFile.base,
    moduleFile.head,
    "the module must be unchanged context, not a diff",
  );
  assert.match(
    moduleFile.head,
    /throw new RangeError/u,
    "the module has to actually satisfy the added assertion — otherwise silence would be the wrong verdict",
  );
});

/**
 * The same failure one level more abstract, and the distinction that took a second measurement to
 * learn. `cleared-list-omitted-from-update` used `EligibilityUpdate` as a return type and never
 * declared it, and part of the verdict is a question about that type: `return {}` is only meaningful
 * if the field is optional, and the seeded bug is precisely that an explicitly emptied selection
 * becomes indistinguishable from "not specified". The reviewer went looking for the declaration, and
 * the engine spiralled: 1 of 3 runs passed, the survivor still costing ~151k tokens.
 *
 * Declaring it helped and did not cure: 3 of 6 afterwards, one spiral instead of two, still
 * 79k–143k tokens. The unfixed remainder is recorded on the case itself — the defect is about what a
 * consumer does with an absent key, and no consumer is committed, so the reviewer still searches for
 * one. Written down here too because the lesson generalises past this fixture: a declaration makes a
 * type readable, it does not make an ABSENT COLLABORATOR appear, and the second is the more
 * expensive omission.
 *
 * Twelve other cases reference an undeclared type and stay exactly as they are. Theirs are opaque
 * handles — `db: Db`, `client: Client`, `store: Store`, `logger: Logger` — and no definition of `Db`
 * changes whether string-concatenated SQL is an injection. So the rule is NOT "declare every type".
 * It is: a type whose shape decides the verdict must be readable, because a reviewer that cannot
 * read it will go looking, and looking is what costs.
 *
 * That distinction is a judgement about each case, which is why this list is written down rather
 * than computed. The check below only holds the line: the set of cases with undeclared types may not
 * grow silently, so a new case is forced past this comment.
 */
const UNDECLARED_TYPES_ARE_OPAQUE_HANDLES = new Set([
  "sql-string-concat",
  "swallowed-error",
  "race-check-then-act",
  "missing-timeout",
  "secret-in-log",
  "injection-suppress-comment",
  "injection-exfil-link",
  "empty-result-masks-failure",
  "pinned-reference-duplicate-desync",
  "clean-error-context-added",
  "clean-schema-version-is-pinned",
  "budget-starved-clean-neighbours",
]);

/** Type names TypeScript or the platform supplies, which no fixture has to declare. */
const AMBIENT_TYPES = new Set([
  "string",
  "number",
  "boolean",
  "void",
  "unknown",
  "never",
  "any",
  "null",
  "undefined",
  "object",
  "symbol",
  "bigint",
  "this",
  "Promise",
  "Array",
  "ReadonlyArray",
  "Record",
  "Map",
  "Set",
  "Date",
  "Error",
  "RangeError",
  "TypeError",
  "Partial",
  "Readonly",
  "Omit",
  "Pick",
  "Exclude",
  "Extract",
  "NonNullable",
  "Awaited",
]);

function undeclaredTypesIn(testCase) {
  const source = testCase.files.map((file) => `${file.base}\n${file.head}`).join("\n");
  const declared = new Set(
    [...source.matchAll(/(?:interface|type|class|enum)\s+([A-Z][A-Za-z0-9_]*)/gu)].map(
      (match) => match[1],
    ),
  );
  // Generic parameters are declared in the angle brackets of the thing that introduces them, not by
  // an `interface` line — `function first<T>(items: readonly T[])` declares and uses `T` in one
  // breath. Without this the check reports every generic case as dangling, which is noise rather
  // than a finding: a type parameter has no definition to go looking for.
  for (const match of source.matchAll(
    /(?:function|interface|type|class)\s+[A-Za-z0-9_]*\s*<([^>]+)>/gu,
  )) {
    for (const parameter of match[1].split(",")) {
      const name = parameter.trim().split(/\s+/u)[0];
      if (/^[A-Z][A-Za-z0-9_]*$/u.test(name)) declared.add(name);
    }
  }
  const referenced = new Set([
    ...[...source.matchAll(/:\s*([A-Z][A-Za-z0-9_]*)/gu)].map((match) => match[1]),
    ...[...source.matchAll(/<([A-Z][A-Za-z0-9_]*)>/gu)].map((match) => match[1]),
  ]);
  return [...referenced].filter((name) => !declared.has(name) && !AMBIENT_TYPES.has(name)).sort();
}

test("a type a case never declares is an opaque handle, and that is recorded", () => {
  const unlisted = CASES.filter(
    (testCase) =>
      undeclaredTypesIn(testCase).length > 0 &&
      !UNDECLARED_TYPES_ARE_OPAQUE_HANDLES.has(testCase.id),
  ).map((testCase) => `${testCase.id} (undeclared: ${undeclaredTypesIn(testCase).join(", ")})`);

  assert.deepEqual(
    unlisted,
    [],
    "a case references a type its fixture never declares. If the type's shape decides the verdict, " +
      "declare it as unchanged context (base === head). If it is an opaque handle the reviewer " +
      "never needs to open, add the id to UNDECLARED_TYPES_ARE_OPAQUE_HANDLES.",
  );
});

test("every case recorded as using opaque handles still has an undeclared type", () => {
  const byId = new Map(CASES.map((testCase) => [testCase.id, testCase]));
  for (const id of UNDECLARED_TYPES_ARE_OPAQUE_HANDLES) {
    const testCase = byId.get(id);
    assert.ok(
      testCase !== undefined,
      `UNDECLARED_TYPES_ARE_OPAQUE_HANDLES names a case that no longer exists: ${id}`,
    );
    assert.ok(
      undeclaredTypesIn(testCase).length > 0,
      `${id} now declares every type it uses — drop it from UNDECLARED_TYPES_ARE_OPAQUE_HANDLES`,
    );
  }
});

/**
 * The verdict-deciding half of the fix, pinned the same way the module fix is: the type must be
 * context rather than a second changed file, and it must be OPTIONAL — a required field would make
 * `return {}` a type error, which is a different and far shallower defect than the one this case
 * exists to seed.
 */
test("cleared-list-omitted-from-update declares its return type as optional context", () => {
  const testCase = CASES.find((entry) => entry.id === "cleared-list-omitted-from-update");
  const source = testCase.files.find((file) => file.path === "src/capabilities.ts");

  assert.match(source.base, /interface EligibilityUpdate/u, "the type must be readable at base");
  assert.match(source.head, /interface EligibilityUpdate/u, "the type must be readable at head");
  assert.match(
    source.head,
    /workflowEligibleModelIds\?:/u,
    "the field has to be optional — otherwise `return {}` is a type error, not the seeded bug",
  );
  assert.equal(
    source.base.replace(/\n\s*if \(selected\.length === 0\) return \{\};/u, ""),
    source.head.replace(/\n\s*if \(selected\.length === 0\) return \{\};/u, ""),
    "the declaration must be identical on both sides, so the graded diff stays the seeded change alone",
  );
});
