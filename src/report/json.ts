import type { ReportFinding, ReportInput, ReportInventory, ReportSpend } from "./types.js";

/**
 * The versioned JSON report (schema v1).
 *
 * The identifier below is the wire contract both IDE extension epics pin to (issue #97): additive
 * changes stay under this same string, and a breaking change requires a new one. `settlement` is
 * always emitted as its own object, independent of `findings` — an incomplete or abandoned run
 * with zero findings still carries `settlement.outcome` sitting right beside an empty `findings`
 * array, so a consumer that only checks array length can never mistake the one for the other.
 */
export const JSON_REPORT_SCHEMA = "keiko-for-quality.local-report/v1";

export interface JsonReportFinding {
  readonly path: string;
  /** `null` = file-level (input sentinel `0`, docs/local-report-schema.md); otherwise 1-based. */
  readonly startLine: number | null;
  readonly endLine: number | null;
  /** `null`, never an omitted key, when the finding stayed unclassified — same fixed-key-set rule
   *  as `JsonReportSettlement.reason` below. */
  readonly category: NonNullable<ReportFinding["category"]> | null;
  readonly severity: NonNullable<ReportFinding["severity"]> | null;
  readonly body: string;
}

export interface JsonReportSettlement {
  readonly outcome: ReportInput["outcome"];
  /** `null`, never an omitted key, when the run has no recorded reason — a fixed key set is part
   *  of what makes this schema stable across every outcome. */
  readonly reason: string | null;
}

export interface JsonReport {
  readonly schema: typeof JSON_REPORT_SCHEMA;
  readonly settlement: JsonReportSettlement;
  readonly engineVersion: string;
  readonly ruleDigest: string;
  readonly spend: ReportSpend;
  readonly inventory: ReportInventory;
  readonly findings: readonly JsonReportFinding[];
}

function toJsonFinding(finding: ReportFinding): JsonReportFinding {
  const fileLevel = finding.startLine === 0 && finding.endLine === 0;
  return {
    path: finding.path,
    startLine: fileLevel ? null : finding.startLine,
    endLine: fileLevel ? null : finding.endLine,
    category: finding.category ?? null,
    severity: finding.severity ?? null,
    body: finding.body,
  };
}

function toSettlement(input: ReportInput): JsonReportSettlement {
  return { outcome: input.outcome, reason: input.reason ?? null };
}

/**
 * Builds the versioned JSON report from a review's structural input.
 *
 * Pure and deterministic: the same input always produces a deep-equal object, built with the same
 * fixed key order every time — no wall clock, no random identifier, nothing whose value depends on
 * anything but `input` itself and the fixed order `input.findings` already carries.
 */
export function buildJsonReport(input: ReportInput): JsonReport {
  return {
    schema: JSON_REPORT_SCHEMA,
    settlement: toSettlement(input),
    engineVersion: input.engineVersion,
    ruleDigest: input.ruleDigest,
    spend: input.spend,
    inventory: input.inventory,
    findings: input.findings.map(toJsonFinding),
  };
}

/**
 * Renders the JSON report to its exact wire text.
 *
 * Two-space indentation, stable key order (from `buildJsonReport`'s own fixed construction order).
 * `JSON.stringify` never reorders string keys on a plain object, so the same input renders to
 * byte-identical text on every call.
 */
export function renderJsonReport(input: ReportInput): string {
  return JSON.stringify(buildJsonReport(input), null, 2);
}
