// Pure logic for the consumer-seed release gate (corpus/seed-gate.mjs).
//
// Extracted for the same reason arena-lib.mjs and rule-source.mjs exist: the gate's executable
// is a script with side effects (git worktrees, a child CLI process, real model spend), so the
// hermetic suite (seed-gate.test.mjs) imports THIS module instead — every decision the gate
// makes about a seed or a report is a pure function of its inputs and is tested without a model
// call or a git repository.
//
// Vocabulary, once:
// - A SEED CASE plants one known defect into one real file of a consumer checkout by exact
//   string replacement (`find` → `replace`). Exactness is the calibration contract: when the
//   consumer refactors the file and `find` no longer matches exactly once, the gate must fail
//   loudly as "seed stale — recalibrate", never guess a nearby location.
// - An ATTEMPT is one full CLI review of that seeded commit, evaluated against the local-report
//   wire contract (docs/local-report-schema.md).
// - A case PASSES when any attempt settles `complete` and carries at least one finding in the
//   seeded file. Line proximity is measured and reported (`lineAnchored`) but does not gate:
//   the file is the recall claim, the anchor is a quality metric with its own drift sources.
//   An `incomplete` attempt never counts as found, even when the seeded finding is present in
//   its report — incomplete-never-clean is this repository's settlement invariant, and a
//   release gate must hold the whole pipeline to it, not just the finder.

/** The only report schema this gate understands — check before reading anything else. */
export const LOCAL_REPORT_SCHEMA = "keiko-for-quality.local-report/v1";

/** Findings within this many lines of the seeded region still count as line-anchored. */
export const LINE_SLACK_DEFAULT = 5;

/**
 * Validates the whole case set at load time, so a malformed case aborts the gate (and fails the
 * hermetic suite) before any money is spent. Throws on the first violation; returns the cases
 * unchanged so callers can use it as a pass-through.
 */
export function assertSeedCaseShape(cases) {
  if (!Array.isArray(cases) || cases.length === 0) {
    throw new Error("seed cases: expected a non-empty array");
  }
  const seen = new Set();
  for (const seedCase of cases) {
    assertOneSeedCase(seedCase);
    if (seen.has(seedCase.id)) throw new Error(`seed cases: duplicate id ${seedCase.id}`);
    seen.add(seedCase.id);
  }
  return cases;
}

/** The per-case half of `assertSeedCaseShape`; only the cross-case checks (array shape,
 *  id uniqueness) live with the loop above. */
function assertOneSeedCase(seedCase) {
  const id = seedCase.id;
  if (typeof id !== "string" || id === "") {
    throw new TypeError("seed cases: every case needs an id");
  }
  for (const field of ["file", "find", "replace", "rationale"]) {
    if (typeof seedCase[field] !== "string" || seedCase[field] === "") {
      throw new TypeError(`seed case ${id}: ${field} must be a non-empty string`);
    }
  }
  if (seedCase.find === seedCase.replace) {
    throw new Error(`seed case ${id}: find and replace are identical — no defect is planted`);
  }
  if (seedCase.tier !== 1 && seedCase.tier !== 2) {
    throw new Error(`seed case ${id}: tier must be 1 (blatant) or 2 (subtle)`);
  }
  if (typeof seedCase.required !== "boolean") {
    throw new TypeError(`seed case ${id}: required must be an explicit boolean`);
  }
}

/** 1-based line number of the character at `index` in `content`. */
function lineOfIndex(content, index) {
  let line = 1;
  for (let i = 0; i < index; i += 1) if (content.codePointAt(i) === 10) line += 1;
  return line;
}

/**
 * Applies one seed case to file content. Returns `{ ok: true, content, seedStartLine,
 * seedEndLine }` with 1-based, inclusive lines describing where the replacement sits in the NEW
 * content, or `{ ok: false, reason }` when the seed no longer applies. Zero and multiple matches
 * are both refusals: a seed that matches twice would plant an ambiguous defect, and reporting
 * which situation occurred is what makes recalibration a lookup instead of an investigation.
 */
export function applySeed(content, seedCase) {
  const first = content.indexOf(seedCase.find);
  if (first === -1) {
    return { ok: false, reason: `seed stale — find text not present in ${seedCase.file}` };
  }
  if (content.includes(seedCase.find, first + 1)) {
    return { ok: false, reason: `seed ambiguous — find text matches twice in ${seedCase.file}` };
  }
  const seeded =
    content.slice(0, first) + seedCase.replace + content.slice(first + seedCase.find.length);
  const seedStartLine = lineOfIndex(seeded, first);
  // Anchor the expectation to the replacement's own extent; an empty replacement (pure deletion)
  // still anchors to the line the removed text used to start on.
  const replacementLines = seedCase.replace === "" ? 1 : seedCase.replace.split("\n").length;
  return {
    ok: true,
    content: seeded,
    seedStartLine,
    seedEndLine: seedStartLine + replacementLines - 1,
  };
}

/** True when the finding's line range overlaps the seeded range widened by `slack` on each side. */
function overlapsSeed(finding, seedRange, slack) {
  if (finding.startLine === null || finding.endLine === null) return false;
  return (
    finding.startLine <= seedRange.seedEndLine + slack &&
    finding.endLine >= seedRange.seedStartLine - slack
  );
}

/**
 * Grades one CLI report against one seed case. Pure: the report is the parsed `--format json`
 * output, `seedRange` comes from `applySeed`. Throws on a schema this gate does not understand —
 * grading an unknown wire format would be a measurement of nothing.
 */
export function evaluateAttempt(report, seedCase, seedRange, slack = LINE_SLACK_DEFAULT) {
  if (report.schema !== LOCAL_REPORT_SCHEMA) {
    throw new Error(`unexpected report schema: ${String(report.schema)}`);
  }
  const outcome = report.settlement.outcome;
  const fileFindings = report.findings.filter((finding) => finding.path === seedCase.file);
  return {
    outcome,
    found: outcome === "complete" && fileFindings.length > 0,
    lineAnchored: fileFindings.some((finding) => overlapsSeed(finding, seedRange, slack)),
    fileFindingCount: fileFindings.length,
    noiseCount: report.findings.length - fileFindings.length,
    spendTotal: report.spend.total,
  };
}

/**
 * Settles one case from its attempts, in order. `passed` is "any attempt found it"; the
 * distinction between `missed` (at least one attempt completed, none carried the finding) and
 * `never-complete` (no attempt completed at all) survives into the summary because the two red
 * verdicts demand different responses — recalibrate the case versus debug the pipeline.
 */
export function settleCase(seedCase, attempts) {
  const passed = attempts.some((attempt) => attempt.found);
  const anyComplete = attempts.some((attempt) => attempt.outcome === "complete");
  let status = "never-complete";
  if (passed) status = "passed";
  else if (anyComplete) status = "missed";
  return {
    id: seedCase.id,
    tier: seedCase.tier,
    required: seedCase.required,
    status,
    lineAnchored: attempts.some((attempt) => attempt.found && attempt.lineAnchored),
    attempts,
    spendTotal: attempts.reduce((sum, attempt) => sum + attempt.spendTotal, 0),
  };
}

/**
 * The gate verdict: green means every REQUIRED case that RAN passed. Non-required cases are
 * measured and reported — they exist so a rotating case can stay visible without holding
 * releases hostage — but they never decide the exit code.
 *
 * `omittedRequired` names the required cases a `--case` selection left out. A partial selection
 * is a legitimate diagnostic run and keeps its exit semantics, but it must never read as release
 * evidence: `releaseVerdict` is `PARTIAL` whenever the list is non-empty, and only a full-set
 * `GREEN` satisfies the release rule (AGENTS.md).
 */
export function summarizeGate(caseResults, omittedRequired = []) {
  const requiredFailed = caseResults
    .filter((result) => result.required && result.status !== "passed")
    .map((result) => result.id);
  const advisoryFailed = caseResults
    .filter((result) => !result.required && result.status !== "passed")
    .map((result) => result.id);
  const green = requiredFailed.length === 0;
  let releaseVerdict = green ? "GREEN" : "RED";
  if (omittedRequired.length > 0) releaseVerdict = "PARTIAL";
  return {
    green,
    releaseVerdict,
    requiredFailed,
    omittedRequired,
    advisoryFailed,
    spendTotal: caseResults.reduce((sum, result) => sum + result.spendTotal, 0),
  };
}

/** The verdict line names what the run can honestly claim: a PARTIAL run says so and names what
 *  it skipped, so no `--case` diagnostic can be mistaken for release evidence. */
function renderVerdictLine(summary) {
  if (summary.releaseVerdict === "PARTIAL") {
    return (
      `- Verdict: PARTIAL (diagnostics only — omitted required: ` +
      `${summary.omittedRequired.join(", ")}; NOT release evidence)`
    );
  }
  return `- Verdict: ${summary.releaseVerdict} (required failures: ${
    summary.requiredFailed.length === 0 ? "none" : summary.requiredFailed.join(", ")
  })`;
}

/**
 * Renders the evidence file for a gate run — a plain, honest record in the spirit of
 * corpus/evidence/qualification-*.md, deliberately NOT that format: qualification evidence has
 * its own shape contract (corpus/evidence-shape.mjs), and this gate must never masquerade as a
 * corpus qualification.
 *
 * `reviewerTree` identifies the gate's OWN checkout — commit and dirty state — because
 * `gateVersion` alone cannot: a dirty tree and a release tree render the same version string,
 * and the release rule demands evidence from the candidate's own tree. A dirty or unknown tree
 * is recorded as such rather than rejected — a development iteration is a legitimate run, it
 * just self-disqualifies as release evidence on its face.
 */
export function renderEvidence({
  dateIso,
  gateVersion,
  reviewerTree,
  model,
  base,
  caseResults,
  summary,
}) {
  const lines = [
    `# Consumer-seed gate — ${dateIso}`,
    "",
    `- Reviewer under test: keiko-for-quality ${gateVersion}`,
    `- Reviewer tree: ${reviewerTree}`,
    `- Model: ${model}`,
    `- Base: ${base}`,
    renderVerdictLine(summary),
    `- Total spend (tokens): ${String(summary.spendTotal)}`,
    "",
  ];
  for (const result of caseResults) {
    lines.push(
      `## ${result.id} (tier ${String(result.tier)}, ${result.required ? "required" : "advisory"})`,
      "",
      `- Status: ${result.status}${result.status === "passed" && !result.lineAnchored ? " (file-level only — no attempt anchored near the seeded lines)" : ""}`,
    );
    result.attempts.forEach((attempt, index) => {
      lines.push(
        `- Attempt ${String(index + 1)}: outcome ${attempt.outcome}, ` +
          `${String(attempt.fileFindingCount)} finding(s) in the seeded file` +
          `${attempt.lineAnchored ? " (line-anchored)" : ""}, ` +
          `noise ${String(attempt.noiseCount)}, spend ${String(attempt.spendTotal)}`,
      );
    });
    lines.push("");
  }
  return lines.join("\n");
}
