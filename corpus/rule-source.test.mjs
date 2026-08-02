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
  assert.equal(parsed.rules[0].merge_system_rule, true);
});

// The in-process pin for the #48 defect class: the shapes the harness historically fed the
// builder — raw JSON.parse output, bare or wrapped as `{ profile: raw }` — must NOT survive it.
// `{ profile: raw }` is the exact pre-fix call: it resembled a compiled profile closely enough to
// work until #44 made the builder read a field only the production loader defaults.
test("the historical raw profile shapes are rejected by the production builder", async () => {
  registerTsExtensionHooks();
  const { buildRuleFile } = await import("../src/engine/rule-file.ts");
  const raw = JSON.parse(PROFILE_TEXT);
  assert.throws(() => buildRuleFile({ profile: raw }), TypeError);
  assert.throws(() => buildRuleFile(raw), TypeError);
});

test("hook registration is idempotent", async () => {
  registerTsExtensionHooks();
  registerTsExtensionHooks();
  const document = await generateRuleDocument(PROFILE_TEXT);
  assert.ok(document.length > 0);
});
