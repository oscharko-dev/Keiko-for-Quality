#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { pathToFileURL } from "node:url";

import {
  KEIKO_GATE_ID,
  REPOSITORY_GATE_CONTRACT,
  SONAR_MAIN_BRANCH,
  SONAR_ORGANIZATION,
  SONAR_PROJECT_KEY,
  countAwareRateFailures,
  gateContractFailures,
} from "./sonar-quality-gate-contract.mjs";

const SONAR_BASE_URL = "https://sonarcloud.io";
const COVERABLE_PREFIXES = ["corpus/", "scripts/", "src/", "widget/"];
const NEW_CODE_RATINGS = Object.freeze([
  ["new_maintainability_rating", "New-code maintainability rating"],
  ["new_reliability_rating", "New-code reliability rating"],
  ["new_security_rating", "New-code security rating"],
]);

export function finiteNumber(value) {
  if (value === undefined || value === null || value === "") return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function isCoverableProductSource(path) {
  if (!COVERABLE_PREFIXES.some((prefix) => path.startsWith(prefix))) return false;
  if (!/\.(?:mjs|ts)$/u.test(path)) return false;
  return !/(?:^|\/)[^/]+\.test\.(?:mjs|ts)$/u.test(path);
}

function changedPaths(diff) {
  return diff
    .split(/\r?\n/u)
    .filter(Boolean)
    .map((line) => line.split("\t").at(-1))
    .filter((path) => path !== undefined);
}

export function isAnalyzableChange(input) {
  const { base, execute = execFileSync, head, root = process.cwd() } = input ?? {};
  if (base === undefined || base.length === 0 || head === undefined || head.length === 0)
    return true;
  const diff = execute(
    "/usr/bin/git",
    ["diff", "--name-status", "--diff-filter=ACMR", `${base}...${head}`],
    { cwd: root, encoding: "utf8" },
  );
  return changedPaths(diff).some(isCoverableProductSource);
}

function analysisFailures(analysis, headSha) {
  const failures = [];
  if (analysis === undefined) failures.push("SonarCloud has no analysis for this pull request.");
  if (analysis?.commitSha !== headSha) {
    failures.push("SonarCloud analysis is not bound to the current head commit.");
  }
  if (analysis?.qualityGateStatus !== REPOSITORY_GATE_CONTRACT.nativeGateStatus) {
    failures.push(`SonarCloud native quality gate is ${analysis?.qualityGateStatus ?? "missing"}.`);
  }
  return failures;
}

function issueFailures(issuesTotal) {
  if (issuesTotal === undefined) return ["SonarCloud issue total is missing."];
  if (issuesTotal !== REPOSITORY_GATE_CONTRACT.unresolvedIssuesMaximum) {
    return [`SonarCloud reports ${String(issuesTotal)} unresolved issue(s).`];
  }
  return [];
}

function violationFailures(measures) {
  if (measures.new_violations === undefined) return ["New-code violation metric is missing."];
  if (measures.new_violations !== REPOSITORY_GATE_CONTRACT.newViolationsMaximum) {
    return [`SonarCloud reports ${String(measures.new_violations)} new violation(s).`];
  }
  return [];
}

function ratingFailures(measures) {
  return NEW_CODE_RATINGS.flatMap(([metric, label]) => {
    const rating = measures[metric];
    if (rating === undefined) return [`${label} metric is missing.`];
    // Sonar ratings use the closed numeric scale A=1 through E=5. Rejecting values outside that
    // scale matters because a malformed zero would otherwise satisfy the repository's <=1 gate.
    if (rating < 1 || rating > 5) return [`${label} metric is invalid.`];
    if (rating > REPOSITORY_GATE_CONTRACT.newCodeRatingMaximum) {
      return [`${label} condition failed at ${String(rating)}.`];
    }
    return [];
  });
}

function newCodeFailures(measures, analyzable) {
  if (!analyzable) return [];
  const failures = [];
  if (measures.new_lines === undefined) failures.push("New-code line count metric is missing.");
  if (measures.new_lines === undefined) {
    failures.push("Cannot evaluate new-code coverage: Sonar did not report a new-code line count.");
  } else {
    failures.push(
      ...countAwareRateFailures({
        count: measures.new_lines_to_cover,
        label: "New-code coverage",
        rate: measures.new_coverage,
        violates: (value) => value < REPOSITORY_GATE_CONTRACT.newCodeCoverageMinimum,
      }),
    );
  }
  failures.push(
    ...countAwareRateFailures({
      count: measures.new_duplicated_lines,
      label: "New-code duplication",
      rate: measures.new_duplicated_lines_density,
      violates: (value) => value > REPOSITORY_GATE_CONTRACT.newCodeDuplicationMaximum,
    }),
    ...countAwareRateFailures({
      count: measures.new_security_hotspots,
      label: "New-code security-hotspot review",
      rate: measures.new_security_hotspots_reviewed,
      violates: (value) => value < REPOSITORY_GATE_CONTRACT.newCodeHotspotReviewMinimum,
    }),
  );
  return failures;
}

function overallHotspotFailures(measures) {
  const availableMeasures = measures ?? {};
  return countAwareRateFailures({
    count: availableMeasures.security_hotspots,
    label: "Overall security-hotspot review",
    rate: availableMeasures.security_hotspots_reviewed,
    violates: (value) => value < REPOSITORY_GATE_CONTRACT.overallHotspotReviewMinimum,
  });
}

export function evaluateSonarPullRequest({
  analysis,
  analyzable = true,
  customGate,
  headSha,
  issuesTotal,
  measures,
  overallMeasures,
}) {
  return [
    ...analysisFailures(analysis, headSha),
    ...issueFailures(issuesTotal),
    ...violationFailures(measures),
    ...ratingFailures(measures),
    ...newCodeFailures(measures, analyzable),
    ...overallHotspotFailures(overallMeasures),
    ...gateContractFailures(customGate),
  ];
}

export async function sonarJson(path, token, request = globalThis.fetch) {
  const headers =
    token === undefined || token.length === 0 ? {} : { Authorization: `Bearer ${token}` };
  const response = await request(`${SONAR_BASE_URL}${path}`, { headers });
  if (!response.ok) throw new Error(`SonarCloud API returned ${String(response.status)}.`);
  return response.json();
}

export function measuresFromPayload(payload) {
  return Object.fromEntries(
    (payload.component?.measures ?? []).map((measure) => [
      measure.metric,
      finiteNumber(measure.period?.value ?? measure.periods?.[0]?.value ?? measure.value),
    ]),
  );
}

async function fetchEvidence(pullRequest, token, load) {
  const project = encodeURIComponent(SONAR_PROJECT_KEY);
  const pr = encodeURIComponent(pullRequest);
  const organization = encodeURIComponent(SONAR_ORGANIZATION);
  const branch = encodeURIComponent(SONAR_MAIN_BRANCH);
  const newMetrics =
    "new_coverage,new_duplicated_lines,new_duplicated_lines_density,new_lines,new_lines_to_cover,new_maintainability_rating,new_reliability_rating,new_security_hotspots,new_security_hotspots_reviewed,new_security_rating,new_violations";
  const overallMetrics = "security_hotspots,security_hotspots_reviewed";
  const [pullRequests, issues, measures, overall, customGate] = await Promise.all([
    load(`/api/project_pull_requests/list?project=${project}`, token),
    load(
      `/api/issues/search?componentKeys=${project}&pullRequest=${pr}&resolved=false&ps=1`,
      token,
    ),
    load(
      `/api/measures/component?component=${project}&pullRequest=${pr}&metricKeys=${newMetrics}`,
      token,
    ),
    load(
      `/api/measures/component?component=${project}&branch=${branch}&metricKeys=${overallMetrics}`,
      token,
    ),
    load(`/api/qualitygates/show?organization=${organization}&id=${KEIKO_GATE_ID}`, token),
  ]);
  const entry = pullRequests.pullRequests?.find((candidate) => candidate.key === pullRequest);
  return {
    analysis:
      entry === undefined
        ? undefined
        : { commitSha: entry.commit?.sha, qualityGateStatus: entry.status?.qualityGateStatus },
    customGate,
    issuesTotal: finiteNumber(issues.total),
    measures: measuresFromPayload(measures),
    overallMeasures: measuresFromPayload(overall),
  };
}

export async function runSonarPullRequestGate({
  base,
  execute,
  headSha,
  load = sonarJson,
  log = console.log,
  pullRequest,
  root,
  token,
}) {
  const evidence = await fetchEvidence(pullRequest, token, load);
  const analyzable = isAnalyzableChange({ base, execute, head: headSha, root });
  const failures = evaluateSonarPullRequest({ ...evidence, analyzable, headSha });
  if (failures.length > 0) throw new Error(failures.join(" "));
  log(`sonar-pr-quality-gate: PASS - PR #${pullRequest} is clean at ${headSha}.`);
}

export async function runSonarPullRequestGateCli(input) {
  const availableInput = input ?? {};
  const env = availableInput.env ?? process.env;
  const pullRequest = env.SONAR_PULL_REQUEST;
  const headSha = env.SONAR_HEAD_SHA;
  if (pullRequest === undefined || headSha === undefined) {
    throw new Error("SONAR_PULL_REQUEST and SONAR_HEAD_SHA are required.");
  }
  await (availableInput.run ?? runSonarPullRequestGate)({
    base: env.SONAR_BASE_SHA,
    headSha,
    pullRequest,
    token: env.SONAR_TOKEN,
  });
}

export async function executeSonarPullRequestGateCli(input) {
  const availableInput = input ?? {};
  try {
    await runSonarPullRequestGateCli(availableInput);
  } catch (error) {
    (availableInput.error ?? console.error)(
      `sonar-pr-quality-gate: FAIL - ${error instanceof Error ? error.message : String(error)}`,
    );
    (availableInput.setExitCode ?? ((value) => (process.exitCode = value)))(1);
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  await executeSonarPullRequestGateCli();
}
