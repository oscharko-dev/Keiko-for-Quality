import { ValidationError } from "../core/brands.js";
import { MAX_INSTRUCTION_PATH_LENGTH } from "./profile.js";

/**
 * Where this repository keeps its written engineering rules.
 *
 * A reviewer that only knows general engineering has to argue from first principles, and a reader
 * can always answer "that is your opinion". A reviewer that can say *which written rule* a change
 * breaks is making a checkable claim about the repository the author already agreed to work in.
 * Measured across 268 CodeRabbit findings in this consumer's own history, roughly two in five cite
 * a repository guideline, and Codex attaches an `AGENTS.md` line reference to nearly all of them.
 *
 * Only the **paths** travel into the review, never the contents, and that is the design rather than
 * a shortcut. The first attempt inlined the documents through the engine's `--background-file`, and
 * the engine rejected it: that flag is capped at 8000 characters, while this consumer's `AGENTS.md`
 * alone is 33000. Truncating to fit would have been worse than not citing at all — a model that
 * receives half a rulebook cites rules it never saw the end of.
 *
 * Naming the paths instead costs a couple of hundred characters, and the model reads what it
 * actually needs with the same search tools it uses to find a caller. The documents are named from
 * the **base** checkout, never from the candidate: a candidate that could nominate its own
 * guidelines would be writing the rules it is judged by.
 */
export interface GuidelineIndex {
  readonly paths: readonly string[];
}

/** Enough to name a repository's governance without turning the rule into a directory listing. */
const MAX_DOCUMENTS = 8;

/**
 * Parses the newline- or comma-separated input into repository-relative paths.
 *
 * Rejects absolute paths and any `..` segment. The paths are trusted because of *where they are
 * read from*, and that property only holds while the path cannot leave the checkout.
 */
export function parseGuidelinePaths(raw: string, field = "guidelines"): GuidelineIndex {
  const paths = raw
    .split(/[\n,]/)
    .map((entry) => entry.trim())
    .filter((entry) => entry !== "");
  if (paths.length > MAX_DOCUMENTS) throw new ValidationError(field);
  for (const path of paths) {
    if (path.startsWith("/") || path.includes("\\")) throw new ValidationError(field);
    if (path.split("/").includes("..")) throw new ValidationError(field);
    // Every sibling path field rendered into the same rule prompt already bounds its length —
    // `contractPairs[].paths`, `pathInstructions[].paths` — and this one had not, despite being the
    // same kind of value: a repository path, from the same untrusted `guidelines` action input.
    if (path.length > MAX_INSTRUCTION_PATH_LENGTH) throw new ValidationError(field);
  }
  return { paths };
}
