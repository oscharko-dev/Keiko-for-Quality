import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import {
  ASSET_NAME,
  DIGEST_FILE_NAME,
  digestOf,
  sha256sumLine,
  stageReleaseAssets,
} from "./release-assets.mjs";

/**
 * Hermetic coverage for the release-asset staging logic (issue #98): no network, no GitHub token,
 * no model call — everything here is pure bytes-in/bytes-out plus one real committed artifact
 * (`dist/cli.js`) read from disk. This is the "built artifact exists, parses as ESM, and its
 * digest file matches the bytes" test the issue asks for, run through the exact code path the
 * release workflow itself calls (`node scripts/release-assets.mjs <bundle> <out-dir>`), not a
 * re-description of it.
 */

const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url));
const CLI_BUNDLE_PATH = join(REPO_ROOT, "dist", "cli.js");
const SCRIPT_PATH = fileURLToPath(new URL("./release-assets.mjs", import.meta.url));

test("digestOf matches an independent sha256 computation of the same bytes", () => {
  const bytes = Buffer.from("hello keiko\n");
  const expected = createHash("sha256").update(bytes).digest("hex");
  assert.equal(digestOf(bytes), expected);
});

test("sha256sumLine renders the sha256sum -c record format: hex digest, two spaces, name", () => {
  const digest = "a".repeat(64);
  assert.equal(sha256sumLine(digest, "keiko-cli.js"), `${digest}  keiko-cli.js\n`);
});

test("stageReleaseAssets copies the bundle byte-for-byte under the version-free asset name", () => {
  const bundleBytes = Buffer.from("// pretend bundle\nexport {};\n");
  const staged = stageReleaseAssets(bundleBytes);
  assert.deepEqual(staged.files[ASSET_NAME], bundleBytes);
});

test("stageReleaseAssets' digest file matches an independently recomputed digest of the asset", () => {
  const bundleBytes = Buffer.from("// pretend bundle\nexport {};\n");
  const staged = stageReleaseAssets(bundleBytes);
  const recomputed = createHash("sha256").update(staged.files[ASSET_NAME]).digest("hex");
  assert.equal(staged.digest, recomputed);
  assert.equal(staged.files[DIGEST_FILE_NAME].toString("utf8"), `${recomputed}  ${ASSET_NAME}\n`);
});

test("stageReleaseAssets never produces the same digest for different bytes", () => {
  const a = stageReleaseAssets(Buffer.from("a"));
  const b = stageReleaseAssets(Buffer.from("b"));
  assert.notEqual(a.digest, b.digest);
});

// --- the real, committed artifact -------------------------------------------------------------
//
// dist/cli.js is a committed artifact (build.mjs / check-bundle.mjs already prove it is
// reproducible from source), present at test time the same way check-bundle.mjs's own first read
// of dist/index.js assumes it is — no build step runs inside this test file.

test("dist/cli.js exists and is non-empty", () => {
  const stats = statSync(CLI_BUNDLE_PATH);
  assert.ok(stats.isFile());
  assert.ok(stats.size > 0);
});

test("dist/cli.js parses as ESM under nothing but Node itself", () => {
  // Syntax-only: proves the bundle is well-formed without running it — no engine acquisition, no
  // process side effects, and (per issue #98's own acceptance criterion) no node_modules or
  // tsconfig anywhere on the lookup path for this to succeed.
  assert.doesNotThrow(() => {
    execFileSync(process.execPath, ["--check", CLI_BUNDLE_PATH], { stdio: "pipe" });
  });
});

test("the staged digest for dist/cli.js matches its real, on-disk bytes", () => {
  const bundleBytes = readFileSync(CLI_BUNDLE_PATH);
  const staged = stageReleaseAssets(bundleBytes);
  const independent = createHash("sha256").update(bundleBytes).digest("hex");
  assert.equal(staged.digest, independent);
  assert.deepEqual(staged.files[ASSET_NAME], bundleBytes);
});

// --- the CLI entry point itself: the exact invocation the release workflow makes ---------------

test("release-assets.mjs writes keiko-cli.js and a matching sha256sum.txt to --out-dir", () => {
  const outDir = mkdtempSync(join(tmpdir(), "kfq-release-assets-"));
  try {
    const output = execFileSync(process.execPath, [SCRIPT_PATH, CLI_BUNDLE_PATH, outDir], {
      encoding: "utf8",
    });
    assert.match(output, /keiko-cli\.js\s+sha256:[0-9a-f]{64}/);

    const bundleBytes = readFileSync(CLI_BUNDLE_PATH);
    const writtenAsset = readFileSync(join(outDir, ASSET_NAME));
    assert.deepEqual(writtenAsset, bundleBytes);

    const expectedDigest = createHash("sha256").update(bundleBytes).digest("hex");
    const digestFile = readFileSync(join(outDir, DIGEST_FILE_NAME), "utf8");
    assert.equal(digestFile, `${expectedDigest}  ${ASSET_NAME}\n`);
  } finally {
    rmSync(outDir, { recursive: true, force: true });
  }
});

test("release-assets.mjs fails closed (exit 2) on a missing bundle-path argument", () => {
  assert.throws(
    () => execFileSync(process.execPath, [SCRIPT_PATH], { stdio: "pipe" }),
    (error) => {
      assert.equal(error.status, 2);
      return true;
    },
  );
});
