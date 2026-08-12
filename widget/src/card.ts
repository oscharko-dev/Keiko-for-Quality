/**
 * The quality.keiko.dev widget card: one repository's review record, rendered as a
 * self-contained SVG — the production evolution of the card widget foundation in section 07 of
 * `design-system/index.html`. Its dimensions, colour system, typography, dot grid, orca tile and
 * footer stay on that visual contract: 340px card, #171B18 on a 24px dot grid, a 42px tile with
 * its green glow, mono 21px metrics with 10px labels, an explicit latest-settlement line, a quiet
 * second row of operational signals, and the EX EXPERIENTIA DISCO / quality.keiko.dev footer.
 * This module is the normative production contract; the design page's section 07 is a historical
 * layout specimen, not a live source for metric meaning or future card evolution.
 *
 * Pure function of its inputs — no fetch, no clock, no environment — so the whole visual
 * contract is unit-testable byte-for-byte. The dark theme is the canonical card (the design
 * page's own README example pins `theme=dark`); the light palette is a derived variant for
 * the worker's `?theme=light`, kept coherent with the design system's light tokens.
 *
 * Numbers are the caller's problem on purpose. This module renders what it is handed and
 * nothing else — absent values render as an em dash, never as a fabricated zero, the same
 * honesty rule the run summary follows.
 */

import { orcaMark } from "./logo.js";

export interface CardData {
  readonly owner: string;
  readonly repo: string;
  /** Completed review runs in the trailing thirty days, or undefined when unknown. */
  readonly runs30d?: number;
  /** Share of those runs whose GitHub workflow conclusion was success, 0–100. */
  readonly runSuccessPct?: number;
  /** Findings published in the same window, or undefined when unknown. */
  readonly findings?: number;
  /** Share of those findings whose GitHub review thread is currently resolved, 0–100. */
  readonly resolvedPct?: number;
  /** Findings in the window whose review thread is currently unresolved. */
  readonly openThreads?: number;
  /** Distinct pull requests containing at least one finding from the window. */
  readonly prsWithFindings?: number;
  /** The latest counted GitHub workflow run's status — explicitly not review settlement. */
  readonly runStatus?: "ok" | "not_ok";
  /** Hours since the most recent run, for the "last run" line. */
  readonly lastRunHours?: number;
  /** Pull requests whose latest maintained run summary belongs to the trailing thirty days. */
  readonly summaryRecords30d?: number;
  /** Share of those latest per-PR summaries whose real settlement is `complete`, 0–100. */
  readonly completionPct?: number;
  /** Latest real settlement among the counted summaries. */
  readonly settlementStatus?: "complete" | "incomplete" | "abandoned";
  /** Hours since the event timestamp in the latest counted run summary. */
  readonly lastReviewHours?: number;
  /** Precision on the released chronological historical holdout, never synthetic clean silence. */
  readonly historicalHoldoutPrecisionPct?: number;
  /** Released version whose historical evidence supplied the precision value. */
  readonly qualityVersion?: string;
  /** Exact ISO timestamp at which the GitHub snapshot was collected. */
  readonly dataAsOf?: string;
}

export type CardTheme = "dark" | "light";

interface Palette {
  readonly card: string;
  readonly line: string;
  readonly hairline: string;
  readonly dot: string;
  readonly fg: string;
  readonly muted: string;
  readonly accent: string;
  readonly chipWarn: string;
  readonly statsBg: string;
  readonly tile: string;
  readonly tileGlow: string;
  readonly tileInk: string;
}

/** Dark values verbatim from the design page's card markup; light derived from its tokens. */
const PALETTES: Record<CardTheme, Palette> = {
  dark: {
    card: "#171B18",
    line: "rgba(255,255,255,0.12)",
    hairline: "rgba(255,255,255,0.1)",
    dot: "rgba(233,237,235,0.07)",
    fg: "#F2F5F3",
    muted: "#98A29C",
    accent: "#4EBA87",
    chipWarn: "#D9A24F",
    statsBg: "rgba(255,255,255,0.025)",
    tile: "#4EBA87",
    tileGlow: "rgba(78,186,135,0.45)",
    tileInk: "#1B211E",
  },
  light: {
    card: "#FFFFFF",
    line: "#D5DBD6",
    hairline: "#E3E8E4",
    dot: "rgba(27,33,30,0.06)",
    fg: "#1B211E",
    muted: "#6A746E",
    accent: "#2E8F63",
    chipWarn: "#8A6410",
    statsBg: "rgba(27,33,30,0.025)",
    tile: "#4EBA87",
    tileGlow: "rgba(78,186,135,0.35)",
    tileInk: "#1B211E",
  },
};

const WIDTH = 340;
const HEIGHT = 240;
const PAD_X = 20;
const PAD_Y = 18;
const SANS = "-apple-system,'Segoe UI',Helvetica,Arial,sans-serif";
const MONO = "'JetBrains Mono',SFMono-Regular,Consolas,Menlo,monospace";

/** SVG text content must never carry markup from repo names — escape the five. */
function esc(text: string): string {
  return text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

function metric(value: number | undefined): string {
  return value === undefined ? "—" : String(value);
}

export function formatPercentage(value: number | undefined): string {
  if (value === undefined || !Number.isFinite(value) || value < 0 || value > 100) return "—";
  if (value === 100) return "100%";
  const rounded = Math.round(value * 10) / 10;
  if (rounded === 100) return "<100%";
  if (value > 0 && rounded === 0) return "<0.1%";
  return `${String(rounded)}%`;
}

function lastReviewLabel(hours: number | undefined, status: CardData["settlementStatus"]): string {
  let time = "";
  if (hours !== undefined && hours < 1) time = "last review <1 h ago";
  else if (hours !== undefined && hours < 48) {
    time = `last review ${String(Math.round(hours))} h ago`;
  } else if (hours !== undefined) {
    time = `last review ${String(Math.round(hours / 24))} d ago`;
  }
  if (status === undefined) return time;
  return time === "" ? `latest ${status}` : `${time} · ${status}`;
}

/** The 42px brand tile with its glow, and the orca ink mark inset by the design's 4px. */
function tileBlock(p: Palette): string {
  const inset = 34 / 1024;
  return (
    `<rect x="${String(PAD_X - 6)}" y="${String(PAD_Y - 6)}" width="54" height="54" rx="16" fill="${p.tileGlow}" filter="url(#glow)"/>` +
    `<rect x="${String(PAD_X)}" y="${String(PAD_Y)}" width="42" height="42" rx="11" fill="${p.tile}"/>` +
    `<g transform="translate(${String(PAD_X + 4)},${String(PAD_Y + 4)}) scale(${String(inset)})">${orcaMark(p.tileInk)}</g>`
  );
}

interface MetricColumn {
  readonly value: string;
  readonly label: string;
  readonly accent: boolean;
}

/** Column advance mirrors the flex row: max(value, label) width plus the design's 22px gap. */
function metricsBlock(columns: readonly MetricColumn[], p: Palette): string {
  const valueY = 95;
  const labelY = 109;
  let x = PAD_X;
  const parts: string[] = [];
  for (const col of columns) {
    parts.push(
      `<text x="${String(x)}" y="${String(valueY)}" font-family="${MONO}" font-size="21" fill="${col.accent ? p.accent : p.fg}">${esc(col.value)}</text>`,
      `<text x="${String(x)}" y="${String(labelY)}" font-family="${SANS}" font-size="10" fill="${p.muted}">${esc(col.label)}</text>`,
    );
    const width = Math.max(col.value.length * 12.7, col.label.length * 4.9);
    x += width + 22;
  }
  return parts.join("\n  ");
}

interface HealthMetric {
  readonly value: string;
  readonly label: string;
}

/** Three compact, source-verifiable signals fill the card's operational row without competing
 *  with the primary review record above it. */
function healthBlock(metrics: readonly HealthMetric[], p: Palette): string {
  const centers = [70, 170, 270] as const;
  const parts = [
    `<rect x="${String(PAD_X)}" y="127" width="${String(WIDTH - 2 * PAD_X)}" height="44" rx="8" fill="${p.statsBg}" stroke="${p.hairline}"/>`,
  ];
  for (const [index, item] of metrics.entries()) {
    const x = centers[index];
    if (x === undefined) break;
    parts.push(
      `<text x="${String(x)}" y="147" text-anchor="middle" font-family="${MONO}" font-size="13" fill="${p.fg}">${esc(item.value)}</text>`,
      `<text x="${String(x)}" y="161" text-anchor="middle" font-family="${MONO}" font-size="7.5" letter-spacing="0.35" fill="${p.muted}">${esc(item.label)}</text>`,
    );
  }
  return parts.join("\n  ");
}

function footerBlock(p: Palette): string {
  const lineY = HEIGHT - 37;
  const baseY = HEIGHT - PAD_Y - 4;
  return (
    `<line x1="${String(PAD_X)}" y1="${String(lineY)}" x2="${String(WIDTH - PAD_X)}" y2="${String(lineY)}" stroke="${p.hairline}"/>` +
    `<text x="${String(PAD_X)}" y="${String(baseY)}" font-family="${MONO}" font-size="9.5" letter-spacing="0.7" fill="${p.muted}">EX EXPERIENTIA DISCO</text>` +
    `<text x="${String(WIDTH - PAD_X)}" y="${String(baseY)}" text-anchor="end" font-family="${MONO}" font-size="9.5" fill="${p.accent}">quality.keiko.dev →</text>`
  );
}

interface AsOfLabel {
  readonly value: string;
  readonly label: string;
}

function asOfLabel(value: string | undefined): AsOfLabel {
  if (value === undefined) return { value: "—", label: "DATA AS OF" };
  const milliseconds = Date.parse(value);
  if (!Number.isFinite(milliseconds)) return { value: "—", label: "DATA AS OF" };
  const iso = new Date(milliseconds).toISOString();
  return { value: iso.slice(0, 10), label: `DATA AS OF · ${iso.slice(11, 16)}Z` };
}

export function renderCard(data: CardData, theme: CardTheme = "dark"): string {
  const p = PALETTES[theme];
  const title = "Reviewed by Keiko for Quality";
  const last = esc(lastReviewLabel(data.lastReviewHours, data.settlementStatus));
  const lastColor =
    data.settlementStatus === "incomplete" || data.settlementStatus === "abandoned"
      ? p.chipWarn
      : p.muted;
  const slug = esc(`${data.owner}/${data.repo}`);
  const completion = formatPercentage(data.completionPct);
  const precision = formatPercentage(data.historicalHoldoutPrecisionPct);
  const evidenceLabel =
    data.qualityVersion === undefined
      ? "HOLDOUT PRECISION"
      : `HOLDOUT PREC · ${data.qualityVersion.toUpperCase()}`;
  const asOf = asOfLabel(data.dataAsOf);
  const columns: readonly MetricColumn[] = [
    { value: metric(data.summaryRecords30d), label: "PR records · 30 d", accent: false },
    { value: metric(data.findings), label: "findings · 30 d", accent: false },
    { value: completion, label: "PRs complete", accent: true },
  ];
  const health: readonly HealthMetric[] = [
    { value: precision, label: evidenceLabel },
    { value: metric(data.openThreads), label: "OPEN THREADS" },
    asOf,
  ];
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${String(WIDTH)}" height="${String(HEIGHT)}" viewBox="0 0 ${String(WIDTH)} ${String(HEIGHT)}" role="img" aria-label="${esc(title)} — ${slug}">
  <defs>
    <pattern id="dots" width="24" height="24" patternUnits="userSpaceOnUse" x="12" y="10">
      <circle cx="1" cy="1" r="1.2" fill="${p.dot}"/>
    </pattern>
    <filter id="glow" x="-60%" y="-60%" width="220%" height="220%">
      <feGaussianBlur stdDeviation="9"/>
    </filter>
    <clipPath id="card"><rect x="0.5" y="0.5" width="${String(WIDTH - 1)}" height="${String(HEIGHT - 1)}" rx="12"/></clipPath>
  </defs>
  <rect x="0.5" y="0.5" width="${String(WIDTH - 1)}" height="${String(HEIGHT - 1)}" rx="12" fill="${p.card}" stroke="${p.line}"/>
  <rect x="0.5" y="0.5" width="${String(WIDTH - 1)}" height="${String(HEIGHT - 1)}" rx="12" fill="url(#dots)"/>
  <g clip-path="url(#card)">
  ${tileBlock(p)}
  <text x="75" y="32" font-family="${SANS}" font-size="13.5" font-weight="650" letter-spacing="-0.14" fill="${p.fg}">${esc(title)}</text>
  <text x="75" y="45" font-family="${MONO}" font-size="10" fill="${p.muted}">${slug}</text>
  ${last === "" ? "" : `<text x="75" y="57" font-family="${MONO}" font-size="8.5" fill="${lastColor}">${last}</text>`}
  ${metricsBlock(columns, p)}
  ${healthBlock(health, p)}
  ${footerBlock(p)}
  </g>
</svg>
`;
}
