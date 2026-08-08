/**
 * The quality.keiko.dev widget card: one repository's review record, rendered as a
 * self-contained SVG in the Keiko for Quality design language.
 *
 * Pure function of its inputs — no fetch, no clock, no environment — so the whole visual
 * contract is unit-testable byte-for-byte and the deployment adapter (`worker.ts`) stays a thin
 * shell around data collection and caching. Colors are the design-system tokens
 * (`design-system/index.html`), oklch-converted to hex at build-authoring time, dark and light
 * theme both; the layout mirrors the card widget in section 07 of the system page and the
 * README mock this whole service exists to make true: runs over thirty days, findings, the
 * acted-on share, and the latest outcome as a chip.
 *
 * Numbers are the caller's problem on purpose. This module renders what it is handed and
 * nothing else — absent values render as an em dash, never as a fabricated zero, the same
 * honesty rule the run summary follows.
 */

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
  readonly bg: string;
  readonly card: string;
  readonly line: string;
  readonly fg: string;
  readonly muted: string;
  readonly accent: string;
  readonly warn: string;
}

/** Token values from design-system/index.html, oklch→srgb converted exactly. */
const PALETTES: Record<CardTheme, Palette> = {
  dark: {
    bg: "#141614",
    card: "#1d1f1d",
    line: "#2c2e2d",
    fg: "#f3f6f4",
    muted: "#a9abaa",
    accent: "#4EBA87",
    warn: "#e8aa4e",
  },
  light: {
    bg: "#f3f4f2",
    card: "#ffffff",
    line: "#e1e4e0",
    fg: "#26302b",
    muted: "#5a6660",
    accent: "#2e8f63",
    warn: "#8a6410",
  },
};

const WIDTH = 340;
const HEIGHT = 170;
const FONT = "-apple-system,'Segoe UI',Helvetica,Arial,sans-serif";
const MONO = "SFMono-Regular,Consolas,Menlo,monospace";

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

function outcomeChip(outcome: CardData["outcome"], p: Palette): string {
  if (outcome === undefined) return "";
  const complete = outcome === "complete";
  const color = complete ? p.accent : p.warn;
  const label = outcome.toUpperCase();
  const w = 24 + label.length * 7.6;
  const x = WIDTH - 20 - w;
  const check = complete
    ? `<path d="M${String(x + 11)} 41 l3 3 l5.6 -5.6" fill="none" stroke="${color}" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/>`
    : `<circle cx="${String(x + 13)}" cy="40" r="4" fill="none" stroke="${color}" stroke-width="1.6"/>`;
  return (
    `<rect x="${String(x)}" y="30" width="${String(w)}" height="20" rx="10" fill="none" stroke="${color}" opacity="0.85"/>` +
    check +
    `<text x="${String(x + 22)}" y="44" font-family="${MONO}" font-size="10" letter-spacing="1" fill="${color}">${label}</text>`
  );
}

/** The orca dot: brand circle with the ink swoosh, small enough to read at 40px. */
function orcaMark(p: Palette): string {
  return (
    `<rect x="20" y="24" width="40" height="40" rx="11" fill="${p.accent}" opacity="0.16"/>` +
    `<circle cx="40" cy="44" r="12" fill="${p.accent}"/>` +
    `<path d="M33.5 42.5 c2.6 -4 7.6 -4.7 11 -2 c-1.2 4.7 -5.7 7.4 -11 6.4 Z" fill="${p.card}"/>`
  );
}

export function renderCard(data: CardData, theme: CardTheme = "dark"): string {
  const p = PALETTES[theme];
  const title = "Reviewed by Keiko for Quality";
  const repoLine = esc(`${data.owner}/${data.repo}`);
  // The under-an-hour label carries a literal "<" — escape it like any other text content.
  const last = esc(lastRunLabel(data.lastRunHours));
  const acted = data.actedOnPct === undefined ? "—" : `${String(Math.round(data.actedOnPct))}%`;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${String(WIDTH)}" height="${String(HEIGHT)}" viewBox="0 0 ${String(WIDTH)} ${String(HEIGHT)}" role="img" aria-label="${esc(title)} — ${repoLine}">
  <rect x="0.5" y="0.5" width="${String(WIDTH - 1)}" height="${String(HEIGHT - 1)}" rx="12.5" fill="${p.card}" stroke="${p.line}"/>
  ${orcaMark(p)}
  <text x="72" y="42" font-family="${FONT}" font-size="14.5" font-weight="650" fill="${p.fg}">${esc(title)}</text>
  <text x="72" y="60" font-family="${MONO}" font-size="11" fill="${p.muted}">${repoLine}${last === "" ? "" : ` · ${last}`}</text>
  ${outcomeChip(data.outcome, p)}
  <text x="24" y="118" font-family="${FONT}" font-size="30" font-weight="650" fill="${p.fg}">${metric(data.runs30d)}</text>
  <text x="24" y="138" font-family="${FONT}" font-size="11.5" fill="${p.muted}">runs · 30 d</text>
  <text x="128" y="118" font-family="${FONT}" font-size="30" font-weight="650" fill="${p.fg}">${metric(data.findings)}</text>
  <text x="128" y="138" font-family="${FONT}" font-size="11.5" fill="${p.muted}">findings</text>
  <text x="228" y="118" font-family="${FONT}" font-size="30" font-weight="650" fill="${p.accent}">${acted}</text>
  <text x="228" y="138" font-family="${FONT}" font-size="11.5" fill="${p.muted}">acted on</text>
  <line x1="20" y1="152" x2="${String(WIDTH - 20)}" y2="152" stroke="${p.line}"/>
  <text x="24" y="164" font-family="${MONO}" font-size="8.5" letter-spacing="1.6" fill="${p.muted}">EX EXPERIENTIA DISCO</text>
  <text x="${String(WIDTH - 24)}" y="164" text-anchor="end" font-family="${MONO}" font-size="9" fill="${p.accent}">quality.keiko.dev</text>
</svg>
`;
}
