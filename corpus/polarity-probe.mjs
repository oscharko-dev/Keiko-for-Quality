#!/usr/bin/env node
// Reproduces the measurement in `evidence/precision-instrument-2026-08-09-limits.md` §2: what
// `src/publish/similarity.ts`'s tokenizer does to a claim's polarity, and therefore why rule
// matching must not go through it.
//
//   npm run corpus:polarity
//
// No network, no model, no `gh`. It parses `STOPWORDS` out of the source file rather than restating
// them, so it cannot silently drift from the function it measures — if someone removes `not` from
// that set, this probe reports the new behaviour instead of the old claim.
//
// It exists because the evidence file first cited a script that was never committed. A measurement
// nobody else can run is an assertion.

import { readFileSync } from "node:fs";
import { dirname, join, resolve as resolvePath } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

/** The live stopword set and length floor, read from the function under measurement. */
export function loadTokenizer(source) {
  const start = source.indexOf("const STOPWORDS");
  // Refuse rather than degrade. A negative index would slice from the end of the file, yield an
  // empty stopword set, and quietly report that polarity SURVIVES — the probe would then contradict
  // the evidence it exists to support, and look like a measurement while doing it.
  if (start === -1) {
    throw new Error(
      "similarity.ts has no `const STOPWORDS` — this probe cannot measure its tokenizer",
    );
  }
  const end = source.indexOf("]);", start);
  if (end === -1) throw new Error("the STOPWORDS declaration in similarity.ts is not terminated");
  const block = source.slice(start, end);
  const stopwords = new Set([...block.matchAll(/"([a-z]+)"/gu)].map((match) => match[1]));
  const floor = Number(/word\.length >= (\d+)/u.exec(source)?.[1] ?? 3);
  return {
    stopwords,
    floor,
    tokenize(text) {
      return new Set(
        text
          .replace(/```[\s\S]*?```/gu, " ")
          .toLowerCase()
          .replace(/[^\p{L}\p{N}]+/gu, " ")
          .split(" ")
          .filter((word) => word.length >= floor && !stopwords.has(word)),
      );
    },
  };
}

/** `tokenOverlap`'s shape: shared over the SMALLER set, plus the raw count the floor reads. */
export function overlap(a, b) {
  let shared = 0;
  for (const token of a) if (b.has(token)) shared += 1;
  const smaller = Math.min(a.size, b.size);
  return { score: smaller === 0 ? 0 : shared / smaller, shared };
}

/** The pairs the evidence cites: a claim and its exact negation. */
export const POLARITY_PAIRS = [
  [
    "There is no guard clearing the pending-read flag before the early return, so a repeated request reuses the stale connector authorization state.",
    "There is a guard clearing the pending-read flag before the early return, so a repeated request reuses the stale connector authorization state.",
  ],
  [
    "the request handler does not validate the auth token",
    "the request handler validates the auth token",
  ],
  ["the parser does not normalize the incoming path", "the parser normalizes the incoming path"],
];

/** The phrases a finding states absence with — `CLAIM_PHRASES`' negation family. */
export const NEGATION_PHRASES = ["does not", "no guard", "never clears", "fails to", "is missing"];

export function probe(tokenizer) {
  const pairs = POLARITY_PAIRS.map(([negative, positive]) => {
    const a = tokenizer.tokenize(negative);
    const b = tokenizer.tokenize(positive);
    const result = overlap(a, b);
    return {
      negative,
      positive,
      ...result,
      identical: a.size === b.size && result.shared === a.size,
    };
  });
  const phrases = NEGATION_PHRASES.map((phrase) => ({
    phrase,
    survives: [...tokenizer.tokenize(phrase)],
  }));
  return { pairs, phrases };
}

// Both sides resolved before comparing: `process.argv[1]` carries whatever path the caller typed,
// so `node corpus/polarity-probe.mjs` gave a relative path against an absolute `import.meta.url`
// and the probe silently printed nothing — an evidence script that produces no evidence.
if (
  process.argv[1] !== undefined &&
  resolvePath(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  const source = readFileSync(join(ROOT, "src", "publish", "similarity.ts"), "utf8");
  const tokenizer = loadTokenizer(source);
  const { pairs, phrases } = probe(tokenizer);
  console.log(
    `tokenizer: ${String(tokenizer.stopwords.size)} stopwords, length floor ${String(tokenizer.floor)}, "not" a stopword: ${String(tokenizer.stopwords.has("not"))}\n`,
  );
  console.log("== a claim against its exact negation ==");
  for (const pair of pairs) {
    console.log(
      `  score ${pair.score.toFixed(2)}  shared ${String(pair.shared)}  identical sets: ${String(pair.identical)}`,
    );
    console.log(`    - ${pair.negative.slice(0, 96)}`);
    console.log(`    + ${pair.positive.slice(0, 96)}`);
  }
  console.log("\n== what survives of each negation phrase ==");
  for (const entry of phrases) {
    console.log(`  "${entry.phrase}" -> {${entry.survives.join(",")}}`);
  }
}
