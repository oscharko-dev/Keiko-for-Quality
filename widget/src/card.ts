/**
 * The quality.keiko.dev widget card: one repository's review record, rendered as a
 * self-contained SVG — a faithful transcription of the card widget in section 07 of
 * `design-system/index.html`. Every dimension, colour and spacing below is copied from that
 * markup, not invented here: 340px card, #171B18 on a 24px dot grid, the 42px orca tile with
 * its green glow, mono 21px metrics with 10px labels, the outcome chip right-aligned ON the
 * metrics row, and the EX EXPERIENTIA DISCO / quality.keiko.dev footer above a hairline.
 * When the design page changes, this module follows it — never the other way around.
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
  /** Findings published in the same window, or undefined when unknown. */
  readonly findings?: number;
  /** Share of findings whose conversation was resolved after a code change, 0–100. */
  readonly actedOnPct?: number;
  /** The most recent run's outcome. */
  readonly outcome?: "complete" | "incomplete" | "skipped";
  /** Hours since the most recent run, for the "last run" line. */
  readonly lastRunHours?: number;
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
  readonly chipOk: string;
  readonly chipOkBg: string;
  readonly chipOkLine: string;
  readonly chipWarn: string;
  readonly chipWarnBg: string;
  readonly chipWarnLine: string;
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
    chipOk: "#5FB585",
    chipOkBg: "rgba(78,186,135,0.14)",
    chipOkLine: "rgba(78,186,135,0.4)",
    chipWarn: "#D9A24F",
    chipWarnBg: "rgba(217,162,79,0.14)",
    chipWarnLine: "rgba(217,162,79,0.4)",
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
    chipOk: "#2E8F63",
    chipOkBg: "rgba(46,143,99,0.10)",
    chipOkLine: "rgba(46,143,99,0.35)",
    chipWarn: "#8A6410",
    chipWarnBg: "rgba(138,100,16,0.10)",
    chipWarnLine: "rgba(138,100,16,0.35)",
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

function lastRunLabel(hours: number | undefined): string {
  if (hours === undefined) return "";
  if (hours < 1) return "last run <1 h ago";
  if (hours < 48) return `last run ${String(Math.round(hours))} h ago`;
  return `last run ${String(Math.round(hours / 24))} d ago`;
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

function chipBlock(outcome: CardData["outcome"], p: Palette): string {
  if (outcome === undefined) return "";
  const ok = outcome === "complete";
  const color = ok ? p.chipOk : p.chipWarn;
  const bg = ok ? p.chipOkBg : p.chipWarnBg;
  const line = ok ? p.chipOkLine : p.chipWarnLine;
  const label = outcome.toUpperCase();
  const textW = label.length * 6.4;
  const w = 9 + 11 + 5 + textW + 9;
  const x = WIDTH - PAD_X - w;
  const cy = 88;
  const icon = ok
    ? `<path d="M${String(x + 11)} ${String(cy)} l2.8 2.8 l5.4 -5.6" fill="none" stroke="${color}" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/>`
    : `<circle cx="${String(x + 14.5)}" cy="${String(cy)}" r="4.4" fill="none" stroke="${color}" stroke-width="1.6"/>`;
  return (
    `<rect x="${String(x)}" y="${String(cy - 10.5)}" width="${String(w)}" height="21" rx="10.5" fill="${bg}" stroke="${line}"/>` +
    icon +
    `<text x="${String(x + 25)}" y="${String(cy + 3.5)}" font-family="${MONO}" font-size="9.5" letter-spacing="0.7" fill="${color}">${label}</text>`
  );
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

export function renderCard(data: CardData, theme: CardTheme = "dark"): string {
  const p = PALETTES[theme];
  const title = "Reviewed by Keiko for Quality";
  const last = esc(lastRunLabel(data.lastRunHours));
  const sub = `${esc(`${data.owner}/${data.repo}`)}${last === "" ? "" : ` · ${last}`}`;
  const acted = data.actedOnPct === undefined ? "—" : `${String(Math.round(data.actedOnPct))}%`;
  const columns: readonly MetricColumn[] = [
    { value: metric(data.runs30d), label: "runs · 30 d", accent: false },
    { value: metric(data.findings), label: "findings", accent: false },
    { value: acted, label: "acted on", accent: true },
  ];
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${String(WIDTH)}" height="${String(HEIGHT)}" viewBox="0 0 ${String(WIDTH)} ${String(HEIGHT)}" role="img" aria-label="${esc(title)} — ${esc(`${data.owner}/${data.repo}`)}">
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
  <text x="75" y="36" font-family="${SANS}" font-size="13.5" font-weight="650" letter-spacing="-0.14" fill="${p.fg}">${esc(title)}</text>
  <text x="75" y="51" font-family="${MONO}" font-size="10" fill="${p.muted}">${sub}</text>
  ${metricsBlock(columns, p)}
  ${chipBlock(data.outcome, p)}
  ${footerBlock(p)}
  </g>
</svg>
`;
}
