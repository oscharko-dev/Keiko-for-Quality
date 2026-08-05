import { FINDING_CATEGORIES, isFileLevel } from "./types.js";
import type { FindingCategory, FindingSeverity, ReportFinding, ReportInput } from "./types.js";

/**
 * SARIF 2.1.0 output, hand-rolled as typed literals.
 *
 * No `sarif` package: this repository carries zero runtime dependencies (AGENTS.md, CONTRIBUTING.md),
 * so the shapes below are a deliberately narrow subset of the OASIS SARIF 2.1.0 object model — only
 * the members this tool actually populates, typed precisely enough that a malformed literal fails
 * `tsc`, not a schema validator run later. `sarif.test.ts` documents which official-schema
 * constraints its structural assertions stand in for, and which ones still need a real JSON-Schema
 * validator this module does not add.
 *
 * The central invariant, restated from issue #97: a SARIF consumer must never read an incomplete or
 * abandoned run's empty `results` as a clean one. Two independent signals carry that here —
 * `invocations[0].executionSuccessful` (the field the SARIF spec itself defines for exactly this)
 * and a synthesized `toolExecutionNotifications` entry — plus the full settlement, spend, and
 * inventory surfaced again in `runs[0].properties`, SARIF's own designed extension point, so this
 * format is a complete parallel of the JSON report rather than a lossy summary of it.
 */

export const SARIF_VERSION = "2.1.0";
export const SARIF_SCHEMA_URI =
  "https://raw.githubusercontent.com/oasis-tcs/sarif-spec/master/Schemata/sarif-schema-2.1.0.json";

export const TOOL_NAME = "keiko-for-quality";
const INFORMATION_URI = "https://github.com/oscharko-dev/Keiko-for-Quality";
const RULE_ID_PREFIX = "keiko-for-quality";
const SETTLEMENT_NOTIFICATION_ID = "keiko-for-quality/settlement-not-complete";

export type SarifLevel = "error" | "warning" | "note" | "none";

export interface SarifMessage {
  readonly text: string;
  readonly markdown?: string;
}

export interface SarifArtifactLocation {
  readonly uri: string;
}

export interface SarifRegion {
  readonly startLine: number;
  readonly endLine: number;
}

export interface SarifPhysicalLocation {
  readonly artifactLocation: SarifArtifactLocation;
  /** Absent for a file-level finding — see `toResult`'s 0-anchor sentinel comment. */
  readonly region?: SarifRegion;
}

export interface SarifLocation {
  readonly physicalLocation: SarifPhysicalLocation;
}

export interface SarifReportingDescriptor {
  readonly id: string;
  readonly name: string;
  readonly shortDescription: SarifMessage;
}

export interface SarifResult {
  readonly ruleId: string;
  readonly level: SarifLevel;
  readonly message: SarifMessage;
  readonly locations: readonly [SarifLocation];
}

export interface SarifNotification {
  readonly level: SarifLevel;
  readonly message: SarifMessage;
  readonly descriptor: { readonly id: string };
}

export interface SarifInvocation {
  readonly executionSuccessful: boolean;
  readonly toolExecutionNotifications: readonly SarifNotification[];
}

export interface SarifRunProperties {
  readonly settlementOutcome: ReportInput["outcome"];
  readonly settlementReason: string | null;
  readonly engineVersion: string;
  readonly ruleDigest: string;
  readonly spend: ReportInput["spend"];
  readonly inventory: ReportInput["inventory"];
}

export interface SarifToolComponent {
  readonly name: typeof TOOL_NAME;
  readonly version: string;
  readonly informationUri: string;
  readonly rules: readonly SarifReportingDescriptor[];
}

export interface SarifRun {
  readonly tool: { readonly driver: SarifToolComponent };
  readonly invocations: readonly [SarifInvocation];
  readonly results: readonly SarifResult[];
  readonly properties: SarifRunProperties;
}

export interface SarifLog {
  readonly $schema: string;
  readonly version: typeof SARIF_VERSION;
  readonly runs: readonly [SarifRun];
}

/** `critical`/`high` both read as `error`: SARIF's three-level scale is coarser than this
 *  product's four-step severity, and a `critical` finding is not a lesser `error` than a `high`
 *  one — the distinction survives in `results[].message.text` and the JSON report, not in `level`. */
const SEVERITY_LEVEL: Readonly<Record<FindingSeverity, SarifLevel>> = {
  critical: "error",
  high: "error",
  medium: "warning",
  low: "note",
};

/**
 * An unclassified finding maps to SARIF's own "no level implied" value rather than a fabricated
 * severity — `none` is spec-legal on a result and is the honest rendering of a classification this
 * pipeline refused to invent (see `ReportFinding.category`'s doc comment).
 */
export function severityToLevel(severity: FindingSeverity | undefined): SarifLevel {
  return severity === undefined ? "none" : SEVERITY_LEVEL[severity];
}

/** The rule id reported for a finding whose category never got classified. Declared alongside the
 *  seven category rules in `buildRules`, so a consumer caching rule metadata sees a fixed set. */
const UNCLASSIFIED_RULE_ID = `${RULE_ID_PREFIX}/unclassified`;

const CATEGORY_LABELS: Readonly<Record<FindingCategory, string>> = {
  bug: "Bug",
  security: "Security",
  performance: "Performance",
  maintainability: "Maintainability",
  test: "Test coverage",
  documentation: "Documentation",
  other: "Other",
};

function categoryRuleId(category: FindingCategory): string {
  return `${RULE_ID_PREFIX}/${category}`;
}

/**
 * One `reportingDescriptor` per category in the closed vocabulary, always all seven regardless of
 * which categories this particular run's findings actually use. A rule set that shrank or grew
 * with the findings present would make the SAME tool report a different taxonomy from one run to
 * the next, which is a worse property for a consumer caching rule metadata across runs than
 * declaring the whole fixed taxonomy up front.
 */
function buildRules(): readonly SarifReportingDescriptor[] {
  return [
    ...FINDING_CATEGORIES.map((category) => ({
      id: categoryRuleId(category),
      name: CATEGORY_LABELS[category],
      shortDescription: { text: `${CATEGORY_LABELS[category]} findings.` },
    })),
    {
      id: UNCLASSIFIED_RULE_ID,
      name: "Unclassified",
      shortDescription: { text: "Findings whose classification never arrived." },
    },
  ];
}

/**
 * `encodeURI` rather than a bare path: `artifactLocation.uri` is a URI reference per the SARIF
 * spec, and a repository-relative path can contain characters (a space, for one) that are legal in
 * a `RepoPath` but not in an unencoded URI. `encodeURI` leaves `/` intact, which is what a
 * multi-segment relative path needs.
 */
function toResult(finding: ReportFinding): SarifResult {
  // The 0-anchor sentinel (docs/local-report-schema.md): SARIF forbids `startLine: 0`, and an
  // artifact location WITHOUT a region is exactly "the file as a whole" — so a file-level finding
  // drops the region rather than smuggling an illegal or fabricated line number in.
  const fileLevel = isFileLevel(finding);
  return {
    ruleId:
      finding.category === undefined ? UNCLASSIFIED_RULE_ID : categoryRuleId(finding.category),
    level: severityToLevel(finding.severity),
    message: { text: finding.body, markdown: finding.body },
    locations: [
      {
        physicalLocation: {
          artifactLocation: { uri: encodeURI(finding.path) },
          ...(fileLevel
            ? {}
            : { region: { startLine: finding.startLine, endLine: finding.endLine } }),
        },
      },
    ],
  };
}

/**
 * The non-complete signal's message half. Empty for a `complete` run — nothing to say, and the
 * invocation below already reports success.
 */
function settlementNotifications(input: ReportInput): readonly SarifNotification[] {
  if (input.outcome === "complete") return [];
  const reason = input.reason ?? "no reason recorded";
  return [
    {
      level: "error",
      message: {
        text:
          `Local review settled as "${input.outcome}" (${reason}). ` +
          "An empty results list above must not be read as a clean run.",
      },
      descriptor: { id: SETTLEMENT_NOTIFICATION_ID },
    },
  ];
}

/**
 * The non-complete signal's structured half: `executionSuccessful` is the field the SARIF spec
 * itself defines for "this invocation did not succeed", so a consumer that only understands the
 * base spec — never looking at `properties` or a notification's free text — still sees it.
 */
function buildInvocation(input: ReportInput): SarifInvocation {
  return {
    executionSuccessful: input.outcome === "complete",
    toolExecutionNotifications: settlementNotifications(input),
  };
}

function buildProperties(input: ReportInput): SarifRunProperties {
  return {
    settlementOutcome: input.outcome,
    settlementReason: input.reason ?? null,
    engineVersion: input.engineVersion,
    ruleDigest: input.ruleDigest,
    spend: input.spend,
    inventory: input.inventory,
  };
}

function buildRun(input: ReportInput): SarifRun {
  return {
    tool: {
      driver: {
        name: TOOL_NAME,
        // The pinned review engine's version, not a separate keiko-for-quality package version —
        // `ReportInput` carries no other version field, and the engine identity is exactly what
        // makes a local run's verdict checkable against the gate's (epic #94's product thesis).
        version: input.engineVersion,
        informationUri: INFORMATION_URI,
        rules: buildRules(),
      },
    },
    invocations: [buildInvocation(input)],
    results: input.findings.map(toResult),
    properties: buildProperties(input),
  };
}

/** Builds the SARIF 2.1.0 log from a review's structural input. Pure and deterministic, like `buildJsonReport`. */
export function buildSarifLog(input: ReportInput): SarifLog {
  return { $schema: SARIF_SCHEMA_URI, version: SARIF_VERSION, runs: [buildRun(input)] };
}

/** Renders the SARIF log to its exact wire text: two-space indentation, stable key order. */
export function renderSarifReport(input: ReportInput): string {
  return JSON.stringify(buildSarifLog(input), null, 2);
}
