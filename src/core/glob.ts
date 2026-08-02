/**
 * A small, total glob compiler.
 *
 * Supports the subset a review profile actually needs: `**` across segments, `*` and `?` within a
 * segment, and `{a,b}` alternation. It is written here rather than taken from a package because
 * this reviewer carries no runtime dependencies, and because path classification decides whether a
 * changed file gets reviewed — a subtle mismatch is a silent coverage hole.
 *
 * Matching is anchored: a pattern must match the entire path.
 */

const REGEXP_SPECIALS = new Set([
  ".",
  "+",
  "^",
  "$",
  "(",
  ")",
  "[",
  "]",
  "|",
  "\\",
  "{",
  "}",
  "*",
  "?",
]);

function escapeLiteral(char: string): string {
  return REGEXP_SPECIALS.has(char) ? `\\${char}` : char;
}

/** Consumes a `{a,b,c}` group starting at `open` and returns the alternation plus the new index. */
function compileBraceGroup(pattern: string, open: number): { source: string; next: number } {
  const close = pattern.indexOf("}", open);
  if (close === -1) return { source: escapeLiteral("{"), next: open + 1 };
  const body = pattern.slice(open + 1, close);
  const alternatives = body.split(",").map((alt) => alt.replace(/[\s\S]/gu, compileSimpleChar));
  return { source: `(?:${alternatives.join("|")})`, next: close + 1 };
}

/** Compiles a character that cannot start a multi-character construct. */
function compileSimpleChar(char: string): string {
  if (char === "*") return "[^/]*";
  if (char === "?") return "[^/]";
  return escapeLiteral(char);
}

/** Handles the `**` forms. Returns null when the position is not a globstar. */
function compileGlobstar(pattern: string, index: number): { source: string; next: number } | null {
  if (!pattern.startsWith("**", index)) return null;
  // `**/` — zero or more complete segments, so `**/x` also matches a bare `x`.
  if (pattern.startsWith("**/", index)) {
    return { source: "(?:[^/]+/)*", next: index + 3 };
  }
  // Trailing `**`, or `**` not followed by a separator: match across segments.
  return { source: ".*", next: index + 2 };
}

export function globToRegExp(pattern: string): RegExp {
  let source = "";
  let index = 0;
  while (index < pattern.length) {
    const globstar = compileGlobstar(pattern, index);
    if (globstar !== null) {
      source += globstar.source;
      index = globstar.next;
      continue;
    }
    const char = pattern[index] ?? "";
    if (char === "{") {
      const group = compileBraceGroup(pattern, index);
      source += group.source;
      index = group.next;
      continue;
    }
    source += compileSimpleChar(char);
    index += 1;
  }
  return new RegExp(`^${source}$`);
}

/** A compiled pattern set that answers "does this path match any of these globs?". */
export class GlobSet {
  private readonly matchers: readonly RegExp[];

  public constructor(patterns: readonly string[]) {
    this.matchers = patterns.map(globToRegExp);
  }

  public matches(path: string): boolean {
    return this.matchers.some((matcher) => matcher.test(path));
  }

  public get size(): number {
    return this.matchers.length;
  }
}
