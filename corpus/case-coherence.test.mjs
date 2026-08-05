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
