import { test } from "node:test";
import assert from "node:assert/strict";

import { renderCard } from "../src/card.ts";

/**
 * The card is a pure function, so these tests pin the visual contract byte-for-byte where it
 * matters: real numbers render, absent numbers render as em dashes and never as zero, repo names
 * cannot inject markup, and the two themes actually differ.
 */

const FULL = {
  owner: "oscharko-dev",
  repo: "Keiko",
  summaryRecords30d: 123,
  findings: 342,
  completionPct: 89.4,
  openThreads: 98,
  settlementStatus: "complete",
  lastReviewHours: 3.2,
  historicalHoldoutPrecisionPct: 27.8,
  qualityVersion: "v0.24.0",
  dataAsOf: "2026-08-12T12:17:00.000Z",
};

test("renders every metric it is handed", () => {
  const svg = renderCard(FULL);
  assert.ok(svg.startsWith("<svg "));
  assert.match(svg, />123</);
  assert.match(svg, />342</);
  assert.match(svg, />89\.4%</);
  assert.match(svg, />27\.8%</);
  assert.match(svg, />98</);
  assert.match(svg, />last review 3 h ago · complete</);
  assert.match(svg, />PR records · 30 d</);
  assert.match(svg, />PRs complete</);
  assert.match(svg, />HOLDOUT PREC · V0\.24\.0</);
  assert.match(svg, />OPEN THREADS</);
  assert.match(svg, />2026-08-12</);
  assert.match(svg, />DATA AS OF · 12:17Z</);
  assert.doesNotMatch(svg, /RUN SUCCESS|resolved/);
  assert.match(svg, /last review 3 h ago/);
  assert.match(svg, /oscharko-dev\/Keiko/);
  assert.match(svg, /quality\.keiko\.dev/);
  assert.match(svg, /EX EXPERIENTIA DISCO/);
});

test("is deterministic", () => {
  assert.equal(renderCard(FULL, "dark"), renderCard(FULL, "dark"));
});

test("absent values render as em dashes, never zero", () => {
  const svg = renderCard({ owner: "o", repo: "r" });
  const dashes = svg.match(/>—</g) ?? [];
  assert.equal(dashes.length, 6);
  assert.doesNotMatch(svg, />0</);
  assert.doesNotMatch(svg, /RUN OK|RUN NOT OK|COMPLETE|INCOMPLETE|SKIPPED/);
  assert.doesNotMatch(svg, /last run/);
});

test("escapes markup in owner and repo names", () => {
  const svg = renderCard({ owner: "a<script>", repo: `b"&'c` });
  assert.doesNotMatch(svg, /<script>/);
  assert.match(svg, /a&lt;script&gt;\/b&quot;&amp;&apos;c/);
});

test("an incomplete settlement renders honestly in the warn colour", () => {
  const svg = renderCard({ owner: "o", repo: "r", settlementStatus: "incomplete" });
  assert.match(svg, />latest incomplete</);
  assert.match(svg, /#D9A24F/);
  assert.doesNotMatch(svg, /RUN OK|RUN NOT OK/);
});

test("only an exact percentage of one hundred renders as 100%", () => {
  const near = renderCard({
    owner: "o",
    repo: "r",
    completionPct: 99.5,
    historicalHoldoutPrecisionPct: 99.99,
  });
  assert.match(near, />99\.5%</);
  assert.match(near, />&lt;100%</);
  assert.doesNotMatch(near, />100%</);

  const exact = renderCard({
    owner: "o",
    repo: "r",
    completionPct: 100,
    historicalHoldoutPrecisionPct: 100,
  });
  assert.equal((exact.match(/>100%</g) ?? []).length, 2);
});

test("themes use their own palettes", () => {
  const dark = renderCard(FULL, "dark");
  const light = renderCard(FULL, "light");
  assert.match(dark, /#171B18/);
  assert.match(light, /#FFFFFF/);
  assert.notEqual(dark, light);
});

test("day granularity takes over past 48 hours", () => {
  assert.match(
    renderCard({ owner: "o", repo: "r", lastReviewHours: 0.4 }),
    /last review &lt;1 h ago/,
  );
  assert.match(renderCard({ owner: "o", repo: "r", lastReviewHours: 72 }), /last review 3 d ago/);
});

test("long repository slugs and last-review time occupy separate header lines", () => {
  const svg = renderCard({
    owner: "oscharko-dev",
    repo: "Keiko-for-Quality",
    lastReviewHours: 1,
  });
  assert.doesNotMatch(svg, /Keiko-for-Quality · last review/);
  assert.match(svg, />oscharko-dev\/Keiko-for-Quality</);
  assert.match(svg, />last review 1 h ago</);
});
