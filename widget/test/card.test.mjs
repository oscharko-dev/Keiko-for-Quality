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
  runs30d: 128,
  runSuccessPct: 98.6,
  findings: 342,
  resolvedPct: 71.4,
  openThreads: 98,
  prsWithFindings: 23,
  runStatus: "ok",
  lastRunHours: 3.2,
};

test("renders every metric it is handed", () => {
  const svg = renderCard(FULL);
  assert.ok(svg.startsWith("<svg "));
  assert.match(svg, />128</);
  assert.match(svg, />342</);
  assert.match(svg, />71\.4%</);
  assert.match(svg, />98\.6%</);
  assert.match(svg, />98</);
  assert.match(svg, />23</);
  assert.match(svg, />RUN OK</);
  assert.match(svg, />resolved</);
  assert.match(svg, />RUNS OK</);
  assert.match(svg, />OPEN THREADS</);
  assert.match(svg, />PRS W\/ FINDINGS</);
  assert.doesNotMatch(svg, /acted on|COMPLETE/);
  assert.match(svg, /last run 3 h ago/);
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

test("a non-successful workflow run renders honestly in the warn colour", () => {
  const svg = renderCard({ owner: "o", repo: "r", runStatus: "not_ok" });
  assert.match(svg, />RUN NOT OK</);
  assert.match(svg, /#D9A24F/);
  assert.doesNotMatch(svg, /INCOMPLETE/);
});

test("only an exact percentage of one hundred renders as 100%", () => {
  const near = renderCard({ owner: "o", repo: "r", resolvedPct: 99.5, runSuccessPct: 99.99 });
  assert.match(near, />99\.5%</);
  assert.match(near, />&lt;100%</);
  assert.doesNotMatch(near, />100%</);

  const exact = renderCard({ owner: "o", repo: "r", resolvedPct: 100, runSuccessPct: 100 });
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
  assert.match(renderCard({ owner: "o", repo: "r", lastRunHours: 0.4 }), /last run &lt;1 h ago/);
  assert.match(renderCard({ owner: "o", repo: "r", lastRunHours: 72 }), /last run 3 d ago/);
});

test("long repository slugs and last-run time occupy separate header lines", () => {
  const svg = renderCard({
    owner: "oscharko-dev",
    repo: "Keiko-for-Quality",
    lastRunHours: 1,
  });
  assert.doesNotMatch(svg, /Keiko-for-Quality · last run/);
  assert.match(svg, />oscharko-dev\/Keiko-for-Quality</);
  assert.match(svg, />last run 1 h ago</);
});
