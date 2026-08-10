#!/usr/bin/env node

import { pathToFileURL } from "node:url";

import {
  evaluateSonarPullRequest,
  finiteNumber,
  isAnalyzableChange,
  measuresFromPayload,
  sonarJson,
} from "./check-sonar-pr-quality-gate.mjs";
import {
  KEIKO_GATE_ID,
  SONAR_MAIN_BRANCH,
  SONAR_ORGANIZATION,
  SONAR_PROJECT_KEY,
} from "./sonar-quality-gate-contract.mjs";

const BRANCH_NEW_CODE_RATE_METRICS = Object.freeze([
  "new_coverage",
  "new_duplicated_lines",
  "new_duplicated_lines_density",
  "new_lines",
  "new_lines_to_cover",
  "new_security_hotspots",
  "new_security_hotspots_reviewed",
]);

function hasBranchNewCodeRateEvidence(measures) {
  return BRANCH_NEW_CODE_RATE_METRICS.some((metric) => measures[metric] !== undefined);
}

async function fetchMainEvidence(token, load) {
  const project = encodeURIComponent(SONAR_PROJECT_KEY);
  const branch = encodeURIComponent(SONAR_MAIN_BRANCH);
  const organization = encodeURIComponent(SONAR_ORGANIZATION);
  const newMetrics =
    "new_coverage,new_duplicated_lines,new_duplicated_lines_density,new_lines,new_lines_to_cover,new_maintainability_rating,new_reliability_rating,new_security_hotspots,new_security_hotspots_reviewed,new_security_rating,new_violations";
  const overallMetrics = "security_hotspots,security_hotspots_reviewed";
  const [analyses, status, issues, measures, overall, customGate] = await Promise.all([
    load(`/api/project_analyses/search?project=${project}&branch=${branch}&ps=1`, token),
    load(`/api/qualitygates/project_status?projectKey=${project}&branch=${branch}`, token),
    // Unlike Keiko's legacy-debt policy, this project is governed at zero total open issues.
    load(`/api/issues/search?componentKeys=${project}&branch=${branch}&resolved=false&ps=1`, token),
    load(
      `/api/measures/component?component=${project}&branch=${branch}&metricKeys=${newMetrics}`,
      token,
    ),
    load(
      `/api/measures/component?component=${project}&branch=${branch}&metricKeys=${overallMetrics}`,
      token,
    ),
    load(`/api/qualitygates/show?organization=${organization}&id=${KEIKO_GATE_ID}`, token),
  ]);
  const latest = analyses.analyses?.[0];
  return {
    analysis:
      latest === undefined
        ? undefined
        : { commitSha: latest.revision, qualityGateStatus: status.projectStatus?.status },
    customGate,
    issuesTotal: finiteNumber(issues.total),
    measures: measuresFromPayload(measures),
    overallMeasures: measuresFromPayload(overall),
  };
}

export async function runSonarMainGate({
  base,
  execute,
  headSha,
  load = sonarJson,
  log = console.log,
  root,
  token,
}) {
  const evidence = await fetchMainEvidence(token, load);
  // Branch measures cover Sonar's whole new-code period, not only this push. Present measures
  // therefore remain load-bearing even for a docs-only push; only an actually empty period may
  // use the Git diff to prove that missing new-code rate evidence is inapplicable.
  const analyzable =
    hasBranchNewCodeRateEvidence(evidence.measures) ||
    isAnalyzableChange({ base, execute, head: headSha, root });
  const failures = evaluateSonarPullRequest({ ...evidence, analyzable, headSha });
  if (failures.length > 0) throw new Error(failures.join(" "));
  log(`sonar-main-quality-gate: PASS - dev is clean at ${headSha}.`);
}

export async function runSonarMainGateCli(input) {
  const availableInput = input ?? {};
  const env = availableInput.env ?? process.env;
  if (env.SONAR_HEAD_SHA === undefined) throw new Error("SONAR_HEAD_SHA is required.");
  await (availableInput.run ?? runSonarMainGate)({
    base: env.SONAR_BASE_SHA,
    headSha: env.SONAR_HEAD_SHA,
    token: env.SONAR_TOKEN,
  });
}

export async function executeSonarMainGateCli(input) {
  const availableInput = input ?? {};
  try {
    await runSonarMainGateCli(availableInput);
  } catch (error) {
    (availableInput.error ?? console.error)(
      `sonar-main-quality-gate: FAIL - ${error instanceof Error ? error.message : String(error)}`,
    );
    (availableInput.setExitCode ?? ((value) => (process.exitCode = value)))(1);
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  await executeSonarMainGateCli();
}
