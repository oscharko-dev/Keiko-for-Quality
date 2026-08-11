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
 * The configured paths select complete documents from the verified merge-base tree. The staged
 * reviewer reads a bounded set once in its Scout step; a document that does not fit every bound is
 * omitted whole rather than truncated. The older `--background-file` attempt could carry only 8000
 * characters and therefore showed half a rulebook for repositories whose `AGENTS.md` was larger.
 *
 * Candidate content can never become guidance: paths come from trusted action configuration and
 * bytes come from the immutable **base**, never from the proposed head. `guideline-context.ts`
 * owns that object-read and framing boundary.
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
