import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { generateRuleDocument, registerTsExtensionHooks } from "./rule-source.mjs";

const PROFILE_TEXT = readFileSync(
  fileURLToPath(new URL("./profile.json", import.meta.url)),
  "utf8",
);

test("builds the committed corpus profile through the production loader", async () => {
  const document = await generateRuleDocument(PROFILE_TEXT);
  const parsed = JSON.parse(document);
  assert.equal(parsed.rules.length, 1);
  assert.ok(parsed.rules[0].rule.includes("Look before you claim"));
  // Same regression pin as rule-file.test.ts (2026-08-03): the engine's unversioned built-in
  // checklist contradicted the supply-chain rule from the most authoritative prompt position, so
  // the merge is off — the corpus must measure the product-owned prompt and nothing else.
  assert.equal(parsed.rules[0].merge_system_rule, false);
});

// Release criterion for v0.10.0 (#26): the qualification run must exercise a profile that
// carries pathInstructions, so the shipped rule shape — including the #44 section — is what the
// corpus measures. The entries in corpus/profile.json do not encode any individual fixture's
// expected verdict, so the rendering path is genuinely executed without turning a case's answer
// into profile policy.
test("the corpus profile renders its path-scoped guidance into the rule", async () => {
  const document = await generateRuleDocument(PROFILE_TEXT);
  const rule = JSON.parse(document).rules[0].rule;
  assert.ok(rule.includes("Path-scoped guidance from the review profile"));
  assert.ok(rule.includes("src/**/*.test.ts"));
  assert.ok(rule.includes("scripts/**"));
});

// The in-process pin for the #48 defect class: shapes that bypass the production loader must NOT
// survive the builder. `{ profile: raw }` is the exact pre-fix call — it resembled a compiled
// profile closely enough to work until #44 made the builder read a field only the loader
// defaults. The pin strips that field explicitly rather than relying on profile.json lacking it:
// the committed profile now carries `pathInstructions`, and a pin contingent on fixture content
// would have been defused by the very edit that added it (which is how this comment got written).
test("shapes that bypass the production loader are rejected by the builder", async () => {
  registerTsExtensionHooks();
  const { buildRuleFile } = await import("../src/engine/rule-file.ts");
  const raw = JSON.parse(PROFILE_TEXT);
  const withoutLoaderDefaults = { ...raw };
  delete withoutLoaderDefaults.pathInstructions;
  assert.throws(() => buildRuleFile({ profile: withoutLoaderDefaults }), TypeError);
  assert.throws(() => buildRuleFile(raw), TypeError);
});

test("hook registration is idempotent", async () => {
  registerTsExtensionHooks();
  registerTsExtensionHooks();
  const document = await generateRuleDocument(PROFILE_TEXT);
  assert.ok(document.length > 0);
});
