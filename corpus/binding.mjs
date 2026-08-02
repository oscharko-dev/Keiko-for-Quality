import { createHash } from "node:crypto";

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import { FIXED_PATH } from "./fixed-path.mjs";

/**
 * The qualification binding: what produced a measurement.
 *
 * A corpus score without this is an anecdote. Recall and precision are properties of a *pairing* —
 * this engine binary, this rule text, this model — and any one of the three can move without a
 * commit in this repository. The binding is what lets a later run say "the number changed and here
 * is the only input that changed with it" instead of "the number changed."
 *
 * Everything recorded here is a digest, a version, or an identifier. The endpoint is reduced to a
 * digest rather than omitted: drift in *which* endpoint answered is exactly the kind of thing a
 * re-qualification must notice, and a digest detects it without writing a URL into an artifact that
 * may be attached to an issue.
 */

const HERE = dirname(fileURLToPath(import.meta.url));

function sha256File(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function sha256Text(text) {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

function adapterCommit() {
  try {
    return execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: join(HERE, ".."),
      encoding: "utf8",
      env: { PATH: FIXED_PATH },
    }).trim();
  } catch {
    // A measurement taken outside a checkout is still a measurement; it is just less traceable,
    // and saying so is more useful than failing the run over provenance.
    return "unknown";
  }
}

/**
 * @param {{ binary: string, rule: string | undefined, model: string, protocol: string,
 *           endpoint: string, measuredAt: string }} inputs
 */
export function buildBinding(inputs) {
  const manifest = JSON.parse(readFileSync(join(HERE, "..", "package.json"), "utf8"));
  return {
    measuredAt: inputs.measuredAt,
    adapter: { version: manifest.version, commit: adapterCommit() },
    engine: { sha256: sha256File(inputs.binary) },
    rule: { sha256: sha256File(inputs.rule) },
    // Both halves of the corpus: the cases and the scorer. Digesting only the data would let a
    // change to what counts as a "find" move every number with nothing in the record to show it.
    corpus: {
      cases: sha256File(join(HERE, "cases.mjs")),
      scorer: sha256File(join(HERE, "run.mjs")),
    },
    model: {
      id: inputs.model,
      protocol: inputs.protocol,
      endpointDigest: sha256Text(inputs.endpoint),
    },
  };
}
