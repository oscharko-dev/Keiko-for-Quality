// Keeps only the SF blocks under the given path prefix in an lcov file, in place.
//
// The corpus suites run under node's own coverage reporter, which emits a DA entry for EVERY
// line — comment lines included — of every module the process LOADED, at zero hits when the
// module was only imported transitively and never executed in-process. src/ modules reach the
// corpus process exactly that way, so appending the unfiltered report to vitest's lcov hands
// SonarCloud zero-hit "lines" that vitest correctly never lists (they are not executable), and
// the merged view reads them as uncovered new code: PR #194 lost 2.6 coverage points to comment
// lines this way. The corpus report exists to give corpus/*.mjs libraries their coverage credit
// — src/ coverage is vitest's job — so everything outside the prefix is dropped before the
// append.
import { readFileSync, writeFileSync } from "node:fs";
import { cliPathArgument } from "./cli-args.mjs";

const USAGE = "usage: node scripts/filter-lcov.mjs <lcov-file>.info <path-prefix>";
const file = cliPathArgument(process.argv[2], { usage: USAGE, mustEndWith: ".info" });
const prefix = process.argv[3];
if (!prefix) {
  console.error(USAGE);
  process.exit(2);
}

// Whole path components only — the reviewer's own finding on #194: a bare "src" prefix would
// also keep "src2/", smuggling unrelated coverage into the filtered report.
const dirPrefix = prefix.endsWith("/") ? prefix : `${prefix}/`;
const blocks = readFileSync(file, "utf8").split("end_of_record\n");
const kept = blocks.filter((block) => {
  const sf = /^SF:(.*)$/m.exec(block);
  return sf?.[1].startsWith(dirPrefix) === true;
});
writeFileSync(file, kept.map((b) => `${b}end_of_record\n`).join(""));
console.log(`filter-lcov: kept ${kept.length} of ${blocks.length - 1} SF blocks under ${prefix}`);
