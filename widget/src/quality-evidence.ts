import type { CardData } from "./card.js";

/**
 * Loads the quality number from the newest published GitHub Release, never from moving `dev`.
 *
 * The card's repository telemetry is live, but precision is a product-wide measured property. The
 * only honest source for it is the chronological holdout in the evidence committed to the release
 * consumers actually run. A package version in the current checkout is not enough: between `prep`
 * and `publish`, `dev` deliberately carries an unreleased version and its candidate evidence.
 */

export interface CardQualityEvidence {
  readonly historicalHoldoutPrecisionPct: number;
  readonly qualityVersion: string;
}

type JsonRecord = Readonly<Record<string, unknown>>;

function record(value: unknown): JsonRecord | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as JsonRecord)
    : undefined;
}

function safeCount(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

function unitMetric(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1
    ? value
    : undefined;
}

function nestedRecord(parent: JsonRecord | undefined, key: string): JsonRecord | undefined {
  return parent === undefined ? undefined : record(parent[key]);
}

function canonicalTimestamp(value: unknown): boolean {
  if (typeof value !== "string") return false;
  const milliseconds = Date.parse(value);
  return Number.isFinite(milliseconds) && new Date(milliseconds).toISOString() === value;
}

interface ParsedEvidence {
  readonly locallyBound: number;
  readonly attempted: number;
  readonly keep: number;
  readonly truePositive: number;
  readonly falsePositive: number;
  readonly precision: number;
}

interface EvidenceRecordSet {
  readonly root: JsonRecord;
  readonly binding: JsonRecord;
  readonly plan: JsonRecord;
  readonly execution: JsonRecord;
  readonly score: JsonRecord;
  readonly decisions: JsonRecord;
  readonly matrix: JsonRecord;
  readonly metrics: JsonRecord;
}

function allRecords(values: readonly (JsonRecord | undefined)[]): values is readonly JsonRecord[] {
  return values.every((entry) => entry !== undefined);
}

function evidenceRecordSet(values: readonly JsonRecord[]): EvidenceRecordSet | undefined {
  const [root, binding, plan, execution, score, decisions, matrix, metrics] = values;
  if (
    root === undefined ||
    binding === undefined ||
    plan === undefined ||
    execution === undefined ||
    score === undefined ||
    decisions === undefined ||
    matrix === undefined ||
    metrics === undefined
  ) {
    return undefined;
  }
  return { root, binding, plan, execution, score, decisions, matrix, metrics };
}

function evidenceRecords(value: unknown): EvidenceRecordSet | undefined {
  const root = record(value);
  const binding = nestedRecord(root, "binding");
  const plan = nestedRecord(root, "plan");
  const execution = nestedRecord(root, "execution");
  const score = nestedRecord(root, "score");
  const chronological = nestedRecord(score, "chronological");
  const holdout = nestedRecord(chronological, "holdout");
  const after = nestedRecord(holdout, "after");
  const decisions = nestedRecord(after, "eligibleDecisions");
  const matrix = nestedRecord(after, "confusionMatrix");
  const metrics = nestedRecord(after, "metrics");
  const values = [root, binding, plan, execution, score, decisions, matrix, metrics];
  return allRecords(values) ? evidenceRecordSet(values) : undefined;
}

function validEvidenceBinding(evidence: ReturnType<typeof evidenceRecords>): boolean {
  if (evidence === undefined) return false;
  return (
    evidence.root.artifact === "keiko-for-quality/historical-replay-evidence" &&
    evidence.root.schemaVersion === 6 &&
    canonicalTimestamp(evidence.root.generatedAt) &&
    evidence.binding.model === "gpt-oss-120b" &&
    evidence.binding.protocol === "openai" &&
    evidence.score.schemaVersion === 1
  );
}

function parsedEvidenceCounts(
  evidence: NonNullable<ReturnType<typeof evidenceRecords>>,
): ParsedEvidence | undefined {
  const locallyBound = safeCount(evidence.plan.locallyBoundCases);
  const attempted = safeCount(evidence.execution.attemptedCases);
  const keep = safeCount(evidence.decisions.keep);
  const truePositive = safeCount(evidence.matrix.truePositive);
  const falsePositive = safeCount(evidence.matrix.falsePositive);
  const precision = unitMetric(evidence.metrics.precision);
  if (
    locallyBound === undefined ||
    attempted === undefined ||
    keep === undefined ||
    truePositive === undefined ||
    falsePositive === undefined ||
    precision === undefined
  ) {
    return undefined;
  }
  return { locallyBound, attempted, keep, truePositive, falsePositive, precision };
}

function consistentHoldout(evidence: ParsedEvidence): boolean {
  return (
    evidence.locallyBound > 0 &&
    evidence.attempted === evidence.locallyBound &&
    evidence.keep > 0 &&
    evidence.keep === evidence.truePositive + evidence.falsePositive &&
    Math.abs(evidence.precision - evidence.truePositive / evidence.keep) <= Number.EPSILON * 8
  );
}

/** Strict projection of the one number the compact card has room to show. */
export function parseCardQualityEvidence(
  value: unknown,
  qualityVersion: string,
): CardQualityEvidence | undefined {
  if (!/^v\d+\.\d+\.\d+$/u.test(qualityVersion)) return undefined;
  const evidence = evidenceRecords(value);
  if (!validEvidenceBinding(evidence) || evidence === undefined) return undefined;
  const holdout = parsedEvidenceCounts(evidence);
  if (holdout === undefined || !consistentHoldout(holdout)) return undefined;
  return { historicalHoldoutPrecisionPct: holdout.precision * 100, qualityVersion };
}

async function githubJson(fetchImpl: typeof fetch, token: string, url: string): Promise<unknown> {
  try {
    const response = await fetchImpl(url, {
      headers: {
        authorization: `Bearer ${token}`,
        accept: "application/vnd.github+json",
        "user-agent": "keiko-quality-widget",
      },
    });
    return response.ok ? await response.json() : undefined;
  } catch {
    return undefined;
  }
}

function evidencePath(tree: JsonRecord, version: string): string | undefined {
  if (tree.truncated !== false || !Array.isArray(tree.tree)) return undefined;
  const escapedVersion = version.replaceAll(".", String.raw`\.`);
  const pattern = new RegExp(
    String.raw`^corpus/evidence/historical-replay-\d{4}-\d{2}-\d{2}-${escapedVersion}\.json$`,
    "u",
  );
  const matches = tree.tree.flatMap((entry) => {
    const node = record(entry);
    return node?.type === "blob" && typeof node.path === "string" && pattern.test(node.path)
      ? [node.path]
      : [];
  });
  return matches.length === 1 ? matches[0] : undefined;
}

function blobText(blob: JsonRecord): string | undefined {
  if (
    blob.encoding !== "base64" ||
    typeof blob.content !== "string" ||
    typeof blob.size !== "number" ||
    !Number.isSafeInteger(blob.size) ||
    blob.size <= 0 ||
    blob.size > 1_000_000
  ) {
    return undefined;
  }
  try {
    const decoded = atob(blob.content.replaceAll("\n", ""));
    const bytes = Uint8Array.from(decoded, (character) => character.codePointAt(0) ?? 0);
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return undefined;
  }
}

function releaseVersion(latest: JsonRecord | undefined): string | undefined {
  const version = latest?.tag_name;
  return typeof version === "string" && /^v\d+\.\d+\.\d+$/u.test(version) ? version : undefined;
}

function evidenceBlobSha(tree: JsonRecord | undefined, version: string): string | undefined {
  if (tree === undefined) return undefined;
  const path = evidencePath(tree, version);
  if (path === undefined || !Array.isArray(tree.tree)) return undefined;
  const node = tree.tree.map(record).find((entry) => entry?.path === path);
  return typeof node?.sha === "string" && /^[\da-f]{40}$/u.test(node.sha) ? node.sha : undefined;
}

function parsedBlobEvidence(
  blob: JsonRecord | undefined,
  version: string,
): CardQualityEvidence | undefined {
  if (blob === undefined) return undefined;
  const text = blobText(blob);
  if (text === undefined) return undefined;
  try {
    return parseCardQualityEvidence(JSON.parse(text) as unknown, version);
  } catch {
    return undefined;
  }
}

/** Fetches latest Release → immutable tag tree → the one version-bound evidence blob. */
export async function loadReleasedQualityEvidence(
  token: string,
  fetchImpl: typeof fetch = fetch,
): Promise<CardQualityEvidence | undefined> {
  const api = "https://api.github.com/repos/oscharko-dev/Keiko-for-Quality";
  const version = releaseVersion(
    record(await githubJson(fetchImpl, token, `${api}/releases/latest`)),
  );
  if (version === undefined) return undefined;
  const tree = record(
    await githubJson(
      fetchImpl,
      token,
      `${api}/git/trees/${encodeURIComponent(version)}?recursive=1`,
    ),
  );
  const sha = evidenceBlobSha(tree, version);
  if (sha === undefined) return undefined;
  return parsedBlobEvidence(
    record(await githubJson(fetchImpl, token, `${api}/git/blobs/${sha}`)),
    version,
  );
}

/** ExactOptionalPropertyTypes-safe merge used by both static and eventual edge renderers. */
export function withQualityEvidence(
  data: CardData,
  evidence: CardQualityEvidence | undefined,
): CardData {
  return evidence === undefined ? data : { ...data, ...evidence };
}
