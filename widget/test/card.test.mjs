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
  findings: 342,
  actedOnPct: 71.4,
  outcome: "complete",
  lastRunHours: 3.2,
};

test("renders every metric it is handed", () => {
  const svg = renderCard(FULL);
  assert.ok(svg.startsWith("<svg "));
  assert.match(svg, />128</);
  assert.match(svg, />342</);
  assert.match(svg, />71%</);
  assert.match(svg, />COMPLETE</);
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
  assert.equal(dashes.length, 3);
  assert.doesNotMatch(svg, />0</);
  assert.doesNotMatch(svg, /COMPLETE|INCOMPLETE|SKIPPED/);
  assert.doesNotMatch(svg, /last run/);
});

test("escapes markup in owner and repo names", () => {
  const svg = renderCard({ owner: "a<script>", repo: `b"&'c` });
  assert.doesNotMatch(svg, /<script>/);
  assert.match(svg, /a&lt;script&gt;\/b&quot;&amp;&apos;c/);
});

test("incomplete renders in the warn colour, not the accent", () => {
  const svg = renderCard({ owner: "o", repo: "r", outcome: "incomplete" });
  assert.match(svg, />INCOMPLETE</);
  assert.match(svg, /#D9A24F/);
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
