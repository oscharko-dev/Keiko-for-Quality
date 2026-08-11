import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { build } from "esbuild";

/** Loads the product's pin and verifier so release audit and runtime cannot drift. */
export async function loadAstGrepPinModule() {
  const directory = await mkdtemp(join(tmpdir(), "kfq-ast-grep-pin-"));
  try {
    const outfile = join(directory, "pin.mjs");
    await build({
      entryPoints: ["src/publish/ast-grep-acquire.ts"],
      outfile,
      bundle: true,
      platform: "node",
      target: "node24",
      format: "esm",
      logLevel: "silent",
    });
    return await import(`file://${outfile}`);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}
