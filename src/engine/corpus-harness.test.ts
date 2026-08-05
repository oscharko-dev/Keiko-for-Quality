import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

// Lives under src/ because the vitest include glob is `src/**/*.test.ts`; its subject is the
// qualification harness's use of the engine and config modules, so this is the nearest owner.
//
// The corpus itself is priced in model tokens, so no CI lane executes it — which is exactly how
// corpus/run.mjs kept crashing at startup after #44 while every test stayed green: the harness fed
// raw profile JSON into `buildRuleFile`, bypassing the production loader that defaults
// `pathInstructions`. This test executes the real script far enough to build the rule document and
// settle, with zero selected cases, a stand-in engine binary that is hashed but never run, and no
// model environment at all. It fails on any startup regression in the harness — loader bypasses,
// broken imports under plain `node`, a corpus profile the validator rejects — for free.
describe("corpus harness startup", () => {
  // The startup guarantee is unchanged and still the point of this test: the script links under
  // plain `node`, routes the corpus profile through the production loader, and reaches its
  // binding. What moved is the exit contract around it. A `--only` value matching no case now
  // exits 2 instead of 0, because a mistyped case id that selects nothing must not read as a
  // clean run of everything — and because a run that measured nothing may never be evidence. The
  // binding line is still printed first, deliberately, so this pin keeps proving rule generation
  // and digest derivation rather than only the refusal.
  it("runs the real script through rule generation, then refuses to score an empty selection", () => {
    const script = fileURLToPath(new URL("../../corpus/run.mjs", import.meta.url));
    const result = spawnSync(process.execPath, [script, "--only", "no-such-case"], {
      cwd: fileURLToPath(new URL("../..", import.meta.url)),
      encoding: "utf8",
      timeout: 60_000,
      env: {
        // A real executable the binding can hash; with zero selected cases it is never spawned.
        OCR_BINARY: process.execPath,
        // The harness's second startup precondition, alongside OCR_BINARY: this project measures
        // only against the pinned model (AGENTS.md), and `run.mjs` refuses to start otherwise. Set
        // here for the same reason OCR_BINARY is — the script requires it, so a test of startup
        // must supply it. Restated as a literal rather than imported from
        // `corpus/qualification-model.mjs`: this pin is the kind a test should hold independently,
        // so that changing the constant fails here and has to be done on purpose.
        OCR_LLM_MODEL: "gpt-oss-120b",
        PATH: process.env.PATH ?? "",
      },
    });
    expect(result.stderr).not.toMatch(/TypeError|ERR_MODULE_NOT_FOUND/);
    expect(result.stdout).toContain("binding");
    expect(result.stderr).toContain("NO CASES SELECTED");
    expect(result.status).toBe(2);
  });

  /**
   * The pinned-model rule, proved against the real script rather than only against its helper.
   * `corpus/qualification-model.test.mjs` covers the decision function; this covers the wiring —
   * that `run.mjs` actually consults it, and does so before anything can cost money.
   *
   * The failure it guards against is precisely the one that happened: on 2026-08-05 a full 32-case
   * qualification ran against `gpt-5.4` because that model was listed first in a consumer's gateway
   * config, producing a plausible, fully green report that measured nothing about the reviewer that
   * ships. Nothing in the repository stopped it. This is what stops it now.
   */
  it("refuses to start against a model this project does not measure against", () => {
    const script = fileURLToPath(new URL("../../corpus/run.mjs", import.meta.url));
    const result = spawnSync(process.execPath, [script, "--only", "off-by-one"], {
      cwd: fileURLToPath(new URL("../..", import.meta.url)),
      encoding: "utf8",
      timeout: 60_000,
      env: {
        OCR_BINARY: process.execPath,
        // A real, capable chat model — refused not because it is bad, but because it is not the
        // one this project's evidence is measured against.
        OCR_LLM_MODEL: "gpt-5.4",
        PATH: process.env.PATH ?? "",
      },
    });
    expect(result.status).toBe(2);
    expect(result.stderr).toContain("gpt-5.4");
    expect(result.stderr).toContain("gpt-oss-120b");
    // Refused at startup, before rule generation and before any case could reach the endpoint —
    // the binding line is never even printed.
    expect(result.stdout).not.toContain("binding");
  });

  // The same startup guarantee for the real-diffs harness, which carried the second instance of
  // the #48 loader bypass. Missing arguments must die at the usage line — cleanly, before any
  // profile, engine, or model concern — proving the script parses and links under plain node.
  it("real-diffs refuses a missing argument with its usage line", () => {
    const script = fileURLToPath(new URL("../../corpus/real-diffs.mjs", import.meta.url));
    const result = spawnSync(process.execPath, [script], {
      cwd: fileURLToPath(new URL("../..", import.meta.url)),
      encoding: "utf8",
      timeout: 60_000,
      env: { OCR_BINARY: process.execPath, PATH: process.env.PATH ?? "" },
    });
    expect(result.stderr).not.toMatch(/TypeError|ERR_MODULE_NOT_FOUND/);
    expect(result.stderr).toContain("usage:");
    expect(result.status).toBe(2);
  });
});
