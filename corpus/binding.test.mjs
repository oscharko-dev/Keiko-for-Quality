import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";

import {
  QUALIFICATION_SCORER_ENTRYPOINTS,
  buildBinding,
  qualificationEngineDigest,
  qualificationSourceClosureDigest,
  qualificationSourceClosureManifest,
} from "./binding.mjs";
import { qualificationEngineIdentity } from "./single-shot-invocation.mjs";

const REPOSITORY_ROOT = join(import.meta.dirname, "..");

function write(root, path, source) {
  const target = join(root, path);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, source);
}

function sourceIdentity(root, entrypoints = ["src/entry.ts", "corpus/context-runner.mjs"]) {
  return { kind: "source-closure", repositoryRoot: root, entrypoints };
}

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "kfq-engine-binding-"));
  write(
    root,
    "src/entry.ts",
    [
      'import { prompt } from "./prompt.js";',
      'import type { PromptShape } from "./types.js";',
      'export { runtimeValue } from "./runtime-value.js";',
      'import "external-package";',
      "void import();",
      "export const review = (): string => prompt;",
      "",
    ].join("\n"),
  );
  write(
    root,
    "src/prompt.ts",
    'import { policy } from "./policy.js";\nexport const prompt = policy;\n',
  );
  write(root, "src/policy.ts", 'export const policy = "check boundaries";\n');
  write(root, "src/runtime-value.ts", "export const runtimeValue = 1;\n");
  write(root, "src/types.ts", "export interface PromptShape { readonly text: string }\n");
  write(root, "src/unrelated.ts", "export const unrelated = true;\n");
  write(
    root,
    "corpus/context-runner.mjs",
    [
      'export async function load() { await import("../src/context-pack.js");',
      'return import("./commonjs-runner.cjs"); }',
      "",
    ].join("\n"),
  );
  write(root, "corpus/commonjs-runner.cjs", 'module.exports = require("./commonjs-policy.cjs");\n');
  write(root, "corpus/commonjs-policy.cjs", 'module.exports = "strict";\n');
  write(root, "src/context-pack.ts", "export const contextPack = 1;\n");
  return root;
}

function assertImportBindsDependency(importDeclaration, before, after) {
  const root = mkdtempSync(join(tmpdir(), "kfq-import-binding-"));
  try {
    write(root, "src/entry.ts", `${importDeclaration}\nexport const entry = true;\n`);
    write(root, "src/dependency.ts", before);
    const identity = sourceIdentity(root, ["src/entry.ts"]);
    const initial = qualificationSourceClosureDigest(identity);
    assert.deepEqual(
      qualificationSourceClosureManifest(identity).sources.map(({ path }) => path),
      ["src/dependency.ts", "src/entry.ts"],
    );

    write(root, "src/dependency.ts", after);
    assert.notEqual(qualificationSourceClosureDigest(identity), initial);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

test("an ordinary empty named import remains a causal runtime binding edge", () => {
  assertImportBindsDependency(
    'import {} from "./dependency.js";',
    "export const sideEffectVersion = 1;\n",
    "export const sideEffectVersion = 2;\n",
  );
});

test("an inline type-only named import remains a causal runtime binding edge", () => {
  assertImportBindsDependency(
    'import { type DependencyShape } from "./dependency.js";',
    "export interface DependencyShape { readonly before: string }\n",
    "export interface DependencyShape { readonly after: string }\n",
  );
});

test("staged engine digest follows runtime prompt and context dependencies transitively", () => {
  const root = fixture();
  try {
    const identity = sourceIdentity(root);
    const initial = qualificationEngineDigest(identity);
    const manifest = qualificationSourceClosureManifest(identity);
    assert.deepEqual(
      manifest.sources.map(({ path }) => path),
      [
        "corpus/commonjs-policy.cjs",
        "corpus/commonjs-runner.cjs",
        "corpus/context-runner.mjs",
        "src/context-pack.ts",
        "src/entry.ts",
        "src/policy.ts",
        "src/prompt.ts",
        "src/runtime-value.ts",
      ],
    );

    write(root, "src/types.ts", "export interface PromptShape { readonly changed: boolean }\n");
    write(root, "src/unrelated.ts", "export const unrelated = false;\n");
    assert.equal(qualificationEngineDigest(identity), initial);

    write(root, "src/policy.ts", 'export const policy = "check exact boundaries";\n');
    const policyChanged = qualificationEngineDigest(identity);
    assert.notEqual(policyChanged, initial);

    write(root, "src/context-pack.ts", "export const contextPack = 2;\n");
    assert.notEqual(qualificationEngineDigest(identity), policyChanged);

    const contextChanged = qualificationEngineDigest(identity);
    write(root, "corpus/commonjs-policy.cjs", 'module.exports = "paranoid";\n');
    assert.notEqual(qualificationEngineDigest(identity), contextChanged);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("staged engine manifest is checkout-independent, ordered, and fail-closed", () => {
  const left = fixture();
  const right = fixture();
  try {
    const forward = sourceIdentity(left);
    const reversed = sourceIdentity(right, [
      "./corpus/context-runner.mjs",
      "./src/entry.ts",
      "src/entry.ts",
    ]);
    assert.deepEqual(
      qualificationSourceClosureManifest(forward),
      qualificationSourceClosureManifest(reversed),
    );
    write(
      left,
      "src/prompt.ts",
      'import { missing } from "./missing.js";\nexport const prompt = missing;\n',
    );
    assert.throws(() => qualificationEngineDigest(forward), /cannot be resolved/u);
    write(
      left,
      "src/prompt.ts",
      'import { outside } from "../../outside.js";\nexport const prompt = outside;\n',
    );
    assert.throws(() => qualificationEngineDigest(forward), /stay inside the repository/u);
  } finally {
    rmSync(left, { recursive: true, force: true });
    rmSync(right, { recursive: true, force: true });
  }
});

test("staged engine manifest refuses a source symlink before reading outside the checkout", () => {
  const root = fixture();
  const outside = mkdtempSync(join(tmpdir(), "kfq-engine-binding-outside-"));
  try {
    write(outside, "policy.ts", 'export const policy = "outside";\n');
    write(
      root,
      "src/prompt.ts",
      'import { policy } from "./linked-policy.js";\nexport const prompt = policy;\n',
    );
    symlinkSync(join(outside, "policy.ts"), join(root, "src/linked-policy.ts"));

    assert.throws(
      () => qualificationEngineDigest(sourceIdentity(root)),
      /qualification source must not traverse a symbolic link/u,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  }
});

test("staged engine manifest refuses a source path whose ancestor is a symlink", () => {
  const root = fixture();
  const outside = mkdtempSync(join(tmpdir(), "kfq-engine-binding-outside-directory-"));
  try {
    write(outside, "policy.ts", 'export const policy = "outside";\n');
    write(
      root,
      "src/prompt.ts",
      'import { policy } from "./linked/policy.js";\nexport const prompt = policy;\n',
    );
    symlinkSync(outside, join(root, "src/linked"), "dir");

    assert.throws(
      () => qualificationEngineDigest(sourceIdentity(root)),
      /qualification source must not traverse a symbolic link/u,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  }
});

test("the repository staged identity reaches every judgment and context policy root", () => {
  const manifest = qualificationSourceClosureManifest(
    qualificationEngineIdentity({
      singleShot: true,
      binary: "/tmp/unused-classic-engine",
      repositoryRoot: REPOSITORY_ROOT,
    }),
  );
  const sources = new Set(manifest.sources.map(({ path }) => path));
  for (const path of [
    "corpus/single-shot-invocation.mjs",
    "src/engine/claim-decision-policy.ts",
    "src/engine/context-pack.ts",
    "src/engine/generation-workflow.ts",
    "src/engine/rule-file.ts",
    "src/engine/single-shot.ts",
  ]) {
    assert.equal(sources.has(path), true, `${path} must be bound`);
  }
});

test("the scorer digest transitively binds graders, classifiers, publication, and gates", () => {
  const identity = {
    kind: "source-closure",
    repositoryRoot: REPOSITORY_ROOT,
    entrypoints: QUALIFICATION_SCORER_ENTRYPOINTS,
  };
  const manifest = qualificationSourceClosureManifest(identity);
  const sources = new Set(manifest.sources.map(({ path }) => path));
  for (const path of [
    "corpus/engine-invocation.mjs",
    "corpus/evidence-shape.mjs",
    "corpus/measurement.mjs",
    "corpus/run.mjs",
    "src/contracts/pin-desync.ts",
    "src/contracts/shape-gate.ts",
    "src/engine/classify.ts",
    "src/publish/publisher.ts",
  ]) {
    assert.equal(sources.has(path), true, `${path} must be scorer-bound`);
  }
  assert.equal(qualificationSourceClosureDigest(identity).length, 64);
});

test("classic qualification identity remains the executable byte digest", () => {
  const root = mkdtempSync(join(tmpdir(), "kfq-classic-binding-"));
  try {
    const binary = join(root, "ocr");
    writeFileSync(binary, Buffer.from([0, 1, 2, 255]));
    assert.equal(
      qualificationEngineDigest({ kind: "file", path: binary }),
      createHash("sha256")
        .update(Buffer.from([0, 1, 2, 255]))
        .digest("hex"),
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("the report binding preserves its schema while using both closure digests", () => {
  const root = mkdtempSync(join(tmpdir(), "kfq-report-binding-"));
  try {
    const binary = join(root, "ocr");
    const rule = join(root, "rule.json");
    writeFileSync(binary, "classic engine\n");
    writeFileSync(rule, '{"rules":[]}\n');
    const report = buildBinding({
      engine: { kind: "file", path: binary },
      rule,
      model: "gpt-oss-120b",
      protocol: "openai",
      endpoint: "https://model.example.test/v1",
      measuredAt: "2026-08-10T00:00:00.000Z",
    });
    assert.deepEqual(Object.keys(report.engine), ["sha256"]);
    assert.deepEqual(Object.keys(report.corpus), ["cases", "scorer"]);
    assert.equal(report.engine.sha256, qualificationEngineDigest({ kind: "file", path: binary }));
    assert.equal(
      report.corpus.scorer,
      qualificationSourceClosureDigest({
        kind: "source-closure",
        repositoryRoot: REPOSITORY_ROOT,
        entrypoints: QUALIFICATION_SCORER_ENTRYPOINTS,
      }),
    );
    assert.equal(report.model.id, "gpt-oss-120b");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
