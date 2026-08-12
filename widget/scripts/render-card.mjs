// Renders one repository's review-record card (dark + light) to static SVG files.
//
// This is the GitHub-only delivery route for the card the README embeds: the quality-cards
// workflow runs it on a schedule, commits the output to the `quality-cards` data branch, and the
// READMEs embed the raw URLs. Same renderer, same collector, same honesty rules as the
// quality.keiko.dev worker (`widget/src/`) — when that service is deployed, the README URL swap
// is the only change. A static card is mutable content by design, like any badge; the
// immutability rule (#184) is about published comments, which never embed these URLs.
//
// Usage: GH_TOKEN=<token> node widget/scripts/render-card.mjs <owner> <repo> <out-dir>

import "../test/ts-hooks.mjs";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

const [owner, repo, outDir] = process.argv.slice(2);
const token = process.env.GH_TOKEN;
if (!owner || !repo || !outDir || !token) {
  console.error("usage: GH_TOKEN=<token> node render-card.mjs <owner> <repo> <out-dir>");
  process.exit(2);
}

const { formatPercentage, renderCard } = await import("../src/card.ts");
const { collectCardData } = await import("../src/collect.ts");
const { loadReleasedQualityEvidence, withQualityEvidence } = await import(
  "../src/quality-evidence.ts"
);
const { createGitHubRequestBudget } = await import("../src/request-budget.ts");

const requests = createGitHubRequestBudget(fetch);
const nowMs = Date.now();
const [repositoryData, qualityEvidence] = await Promise.all([
  collectCardData(owner, repo, token, requests, nowMs),
  loadReleasedQualityEvidence(token),
]);
const data = withQualityEvidence(repositoryData, qualityEvidence);
await mkdir(join(outDir, owner), { recursive: true });
await writeFile(join(outDir, owner, `${repo}.svg`), renderCard(data, "dark"));
await writeFile(join(outDir, owner, `${repo}-light.svg`), renderCard(data, "light"));

const shown = (v) => (v === undefined ? "—" : String(v));
console.log(
  `${owner}/${repo}: summaryRecords30d=${shown(data.summaryRecords30d)} ` +
    `completion=${formatPercentage(data.completionPct)} findings=${shown(data.findings)} ` +
    `openThreads=${shown(data.openThreads)} latestSettlement=${shown(data.settlementStatus)} ` +
    `holdoutPrecision=${formatPercentage(data.historicalHoldoutPrecisionPct)} ` +
    `evidence=${shown(data.qualityVersion)} dataAsOf=${shown(data.dataAsOf)}`,
);
