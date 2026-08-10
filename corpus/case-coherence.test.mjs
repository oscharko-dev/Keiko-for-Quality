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
 * The four cases that carry the shape and are left alone on purpose. Their verdict is decidable from
 * the diff itself — every seeded one hides its defect INSIDE the test file — so none has ever
 * spiralled the way `clean-added-test` did. They stay listed rather than fixed because a fixture is
 * a recorded measurement basis: re-cutting four of them on suspicion, with no failing run to point
 * at, would discard comparability against every qualification already in `corpus/evidence/` and buy
 * nothing. A case that starts failing here earns its fix with evidence, exactly as this one did —
 * and `clean-reset-modules-is-load-bearing` left this list on 2026-08-06 with exactly that
 * evidence (3/3 false positives in the v0.18.0 qualification; see the case's own comment and
 * corpus/evidence/fp-analysis-2026-08-06-clean-reset-modules.md for the record). The budget-starved
 * clean case left the list after its 2026-08-10 qualification failure exposed that the clean verdict
 * was not decidable while the implementation imported by its added test was absent.
 */
const MODULE_OMITTED_ON_PURPOSE = new Set([
  "weakened-assertion",
  "redaction-assertion-loosened",
  "stale-session-after-refresh",
  "clean-test-asserts-the-opposite",
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
 * Same mechanism, second earner: `clean-reset-modules-is-load-bearing` left
 * MODULE_OMITTED_ON_PURPOSE on 2026-08-06 with the evidence that list demands — 3/3 false
 * positives in the v0.18.0 qualification plus one more in a six-run isolated follow-up, every
 * directly observed one anchored on the added test (the observed repair invented a `clearCache`
 * export for a module the repository did not contain). A validation run against the committed
 * module alone then grounded a real name-versus-assertion gap in the added test, so the fix has
 * two halves; see the case's comment in cases.mjs and
 * corpus/evidence/fp-analysis-2026-08-06-clean-reset-modules.md.
 *
 * The module must stay context, it must actually memoize at module scope — a module without
 * module-level state would make the `beforeEach` reset genuinely redundant, turning the exact
 * finding this case exists to punish into a correct one — and it must export the `entryCount`
 * the added test's isolation assertion calls, or the assertion cannot hold and silence would be
 * the wrong verdict.
 */
test("clean-reset-modules-is-load-bearing's module is context, not part of the change", () => {
  const testCase = CASES.find((entry) => entry.id === "clean-reset-modules-is-load-bearing");
  const moduleFile = testCase.files.find((file) => file.path === "src/cache.ts");

  assert.ok(moduleFile !== undefined, "the module under test must be committed with the case");
  assert.equal(
    moduleFile.base,
    moduleFile.head,
    "the module must be unchanged context, not a diff",
  );
  assert.match(
    moduleFile.head,
    /const memo = new Map/u,
    "the module must memoize at module scope — otherwise the reset the case defends really is " +
      "redundant, and the finding this case exists to punish would be correct",
  );
  assert.match(
    moduleFile.head,
    /export function entryCount/u,
    "the module has to actually satisfy the added isolation assertion — otherwise silence would " +
      "be the wrong verdict",
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

function caseById(id) {
  const testCase = CASES.find((entry) => entry.id === id);
  assert.ok(testCase !== undefined, `missing corpus case: ${id}`);
  return testCase;
}

function changedSource(id) {
  return caseById(id)
    .files.filter((file) => file.base !== file.head)
    .map((file) => file.head)
    .join("\n");
}

function headSource(id, path) {
  const file = caseById(id).files.find((entry) => entry.path === path);
  assert.ok(file !== undefined, `${id} is missing ${path}`);
  return file.head;
}

test("qualification corpus keeps the 42-case seeded/clean population contract", () => {
  assert.equal(CASES.length, 42);
  assert.equal(CASES.filter((entry) => entry.defect !== null).length, 31);
  assert.equal(CASES.filter((entry) => entry.defect === null).length, 11);
});

/**
 * The clean reset case and its two recall twins share one real module-state mechanism. The first
 * twin deletes the reset. The second keeps the reset but hoists the module to a static import, so
 * the tests retain bindings to the pre-reset instance. Neither twin uses a cached import Promise:
 * that would add a race-shaped alternative explanation instead of isolating import timing.
 */
test("reset-isolation cases distinguish fresh dynamic imports from removed and bypassed resets", () => {
  const ids = [
    "clean-reset-modules-is-load-bearing",
    "reset-modules-removed-state-bleeds",
    "reset-modules-static-import-bypasses-reset",
  ];
  const fixtures = ids.map((id) => {
    const testCase = caseById(id);
    const moduleFile = testCase.files.find((entry) => entry.path === "src/cache.ts");
    const testFile = testCase.files.find((entry) => entry.path === "src/cache.test.ts");
    assert.ok(moduleFile !== undefined, `${id} must carry the cache module as context`);
    assert.ok(testFile !== undefined, `${id} must carry the cache test`);
    assert.equal(moduleFile.base, moduleFile.head, `${id}'s cache module must stay unchanged`);
    assert.match(moduleFile.head, /const memo = new Map/u);
    return { testCase, testFile };
  });

  const clean = fixtures[0];
  const removed = fixtures[1];
  const bypassed = fixtures[2];
  assert.ok(clean !== undefined);
  assert.ok(removed !== undefined);
  assert.ok(bypassed !== undefined);

  assert.match(clean.testFile.head, /beforeEach\(\(\) => \{\s+vi\.resetModules\(\);/u);
  assert.ok(
    clean.testFile.head.indexOf("vi.resetModules();") <
      clean.testFile.head.indexOf('await import("./cache.js")'),
    "the clean suite must reset the registry before importing the fresh module",
  );
  assert.equal(clean.testFile.head.includes('from "./cache.js";'), false);

  assert.equal(removed.testFile.base, clean.testFile.head);
  assert.doesNotMatch(removed.testFile.head, /resetModules/u);
  assert.equal(removed.testFile.head.match(/await import\("\.\/cache\.js"\)/gu)?.length, 2);

  assert.equal(bypassed.testFile.base, clean.testFile.head);
  assert.match(bypassed.testFile.head, /vi\.resetModules\(\);/u);
  assert.match(bypassed.testFile.head, /^import \{ entryCount, lookup \} from "\.\/cache\.js";/mu);
  assert.doesNotMatch(bypassed.testFile.head, /await import|Promise/u);

  for (const seeded of [removed.testCase, bypassed.testCase]) {
    assert.deepEqual(seeded.defect, {
      file: "src/cache.test.ts",
      category: "test",
      severity: "high",
    });
  }
});

/**
 * The 2026-08-10 failure earned a ground-truth repair, not a reviewer prompt exception. The
 * imported implementation has to be readable without becoming a sixth changed hunk, and its
 * behavior must make every old assertion plus the new empty-input assertion true. The budget and
 * ordered five-hunk shape are the pressure contract; changing either would turn the repaired case
 * into a different experiment for a second, unrelated reason.
 */
test("budget-starved clean case keeps its pressure shape and readable redaction context", () => {
  const testCase = caseById("budget-starved-clean-neighbours");
  const changedFiles = testCase.files.filter((file) => file.base !== file.head);
  const changedPaths = changedFiles.map((file) => file.path);
  const moduleFile = testCase.files.find((file) => file.path === "src/redact-model-id.ts");

  assert.equal(testCase.budgetTokens, 25_000, "the pressure budget is part of the case contract");
  assert.deepEqual(changedPaths, [
    "src/trace-context.ts",
    "src/trust-mode.ts",
    "src/event-envelope.ts",
    "src/workspace-layout.ts",
    "src/redact-model-id.test.ts",
  ]);
  for (const file of changedFiles) {
    assert.ok(file.head.startsWith(file.base), `${file.path} must remain a single appended hunk`);
  }
  assert.ok(moduleFile !== undefined, "the module imported by the added test must be readable");
  assert.equal(moduleFile.base, moduleFile.head, "the module must remain unchanged context");
  assert.match(
    moduleFile.head,
    /export function redactModelId\(modelId: string\): string \{\s+const separator = modelId\.indexOf\("#"\);\s+return separator === -1 \? modelId : modelId\.slice\(0, separator\);\s+\}/u,
    "the unchanged implementation must satisfy the existing suffix cases and the added empty-input case",
  );
});

/**
 * The v0.23 qualification exposed fixture defects rather than proven reviewer noise. The clean
 * identifier addition originally truncated its new UUID; the budgeted fixture's new `hopId` was
 * repaired to keep the full UUID, but deterministic follow-up found its unchanged `traceContext`
 * still created identifiers from only eight UUID hex characters. A collision warning against the
 * current file was therefore defensible even though that truncation predated the hunk. Both
 * revisions must now be clean while the authentication-prefix case remains the positive twin:
 * truncating a secret comparison is still the seeded defect the reviewer must find.
 */
test("clean UUID additions retain full entropy while the prefix-auth defect remains seeded", () => {
  assert.match(
    headSource("clean-import-present-above", "src/ids.ts"),
    /export function traceId\(\): string \{\s+return "trace-" \+ randomUUID\(\);/u,
  );
  const budgetedTrace = caseById("budget-starved-clean-neighbours").files.find(
    (file) => file.path === "src/trace-context.ts",
  );
  assert.ok(budgetedTrace !== undefined, "the budgeted case must retain its trace fixture");
  for (const source of [budgetedTrace.base, budgetedTrace.head]) {
    assert.match(
      source,
      /return \{ id: subsystem \+ "-" \+ randomUUID\(\), subsystem, startedAtMs: nowMs \};/u,
    );
    assert.doesNotMatch(source, /randomUUID\(\)\.slice\(0, 8\)/u);
  }
  assert.match(
    budgetedTrace.head,
    /export function hopId\(context: TraceContext\): string \{\s+return context\.id \+ "\." \+ randomUUID\(\);/u,
  );
  assert.match(
    changedSource("auth-prefix-compare"),
    /provided\.slice\(0, 8\) === expected\.slice\(0, 8\)/u,
    "the true-positive prefix comparison must remain in the recall corpus",
  );
});

/**
 * Existing paid cases are the retention fixtures for the examiner's new evidence contract. Each
 * clean shape has a nearby positive twin where the missing fact is actually visible; pinning both
 * sides prevents a future clean-case calibration from quietly deleting the corresponding recall
 * question instead of teaching the examiner to distinguish it.
 */
test("precision counterexamples retain their visible true-positive twins", () => {
  const cleanPinCase = caseById("clean-workflow-pin-update");
  const cleanPinFile = cleanPinCase.files[0];
  assert.ok(cleanPinFile !== undefined);
  const cleanPinUpdate = changedSource(cleanPinCase.id);
  assert.match(
    cleanPinUpdate,
    /actions\/checkout@11bd71901bbe5b1630ceea73d27597364c9af683 # v4\.2\.2/u,
    "the clean pin update must bind the real v4.2.2 tag commit",
  );
  assert.match(
    cleanPinFile.base,
    /actions\/checkout@d632683dd7b4114ad314bca15554477dd762a938 # v4\.2\.0/u,
    "the clean pin update must begin at the real v4.2.0 tag commit",
  );
  for (const source of [cleanPinFile.base, cleanPinFile.head]) {
    assert.match(
      source,
      /actions\/checkout@[0-9a-f]{40}/u,
      "both clean revisions must keep the same action coordinate fully pinned",
    );
  }

  const loosenedPin = caseById("workflow-unpinned-action").files[0];
  assert.ok(loosenedPin !== undefined);
  assert.match(loosenedPin.base, /actions\/setup-node@[0-9a-f]{40}/u);
  assert.match(loosenedPin.head, /actions\/setup-node@v4/u);

  assert.match(changedSource("clean-literal-is-in-union"), /type Mode = "strict" \| "lenient"/u);
  assert.match(
    changedSource("status-union-widened-consumer-missed"),
    /type CandidateStatus = "draft" \| "needs-review" \| "approved" \| "rejected"/u,
  );

  assert.match(changedSource("clean-refactor"), /new Map<string, string>/u);
  assert.match(changedSource("prototype-lookup-refactor"), /LABELS\[kind\]/u);

  assert.match(changedSource("clean-error-context-added"), /correlationId: client\.id, attempt/u);
  assert.match(
    changedSource("secret-in-log"),
    /logger\.info\("auth attempt", \{ user, token \}\)/u,
  );

  const desynchronized = changedSource("pinned-reference-duplicate-desync");
  assert.match(desynchronized, /ADVANCE BOTH TOGETHER/u);
  const visiblePins = [
    ...desynchronized.matchAll(/(?:ACTION_PIN:\s*|actions\/checkout@)([0-9a-f]{40})/gu),
  ].map((match) => match[1]);
  assert.equal(
    new Set(visiblePins).size,
    2,
    "the true-positive workflow must retain two visibly different full-SHA pins",
  );
});
