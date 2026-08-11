/** A pair of object entries whose previously matching helpers were swapped by the change. */
export interface ParallelMappingCrossover {
  readonly leftKey: string;
  readonly rightKey: string;
  readonly leftHelper: string;
  readonly rightHelper: string;
  readonly line: number;
}

interface MappingEntry {
  readonly key: string;
  readonly helper: string;
  readonly argumentsText: string;
  readonly line: number;
}

const IDENTIFIER = /^[A-Za-z_$][\w$]*$/u;
const EXECUTABLE_EXTENSIONS = new Set([
  ".cjs",
  ".cts",
  ".js",
  ".jsx",
  ".mjs",
  ".mts",
  ".ts",
  ".tsx",
]);

type LexicalState =
  | "block-comment"
  | "code"
  | "double-quote"
  | "line-comment"
  | "single-quote"
  | "template";
type QuotedState = Extract<LexicalState, "double-quote" | "single-quote" | "template">;

interface LexicalTransition {
  readonly consumed: number;
  readonly state: LexicalState;
}

const QUOTE_CLOSING: Readonly<Record<QuotedState, string>> = {
  "double-quote": '"',
  "single-quote": "'",
  template: "`",
};

function quotedTransition(
  source: string,
  index: number,
  state: QuotedState,
): LexicalTransition | undefined {
  if (source[index] === "\\") return { consumed: 2, state };
  return source[index] === QUOTE_CLOSING[state] ? { consumed: 1, state: "code" } : undefined;
}

function nonCodeTransition(
  source: string,
  index: number,
  state: Exclude<LexicalState, "code">,
): LexicalTransition | undefined {
  const char = source[index];
  if (state === "line-comment") return char === "\n" ? { consumed: 1, state: "code" } : undefined;
  if (state === "block-comment") {
    return char === "*" && source[index + 1] === "/" ? { consumed: 2, state: "code" } : undefined;
  }
  return quotedTransition(source, index, state);
}

function codeTransition(source: string, index: number): LexicalTransition {
  const char = source[index];
  const next = source[index + 1];
  if (char === "/" && next === "/") return { consumed: 2, state: "line-comment" };
  if (char === "/" && next === "*") return { consumed: 2, state: "block-comment" };
  if (char === "'") return { consumed: 1, state: "single-quote" };
  if (char === '"') return { consumed: 1, state: "double-quote" };
  if (char === "`") return { consumed: 1, state: "template" };
  return { consumed: 1, state: "code" };
}

function nextLexicalState(
  source: string,
  index: number,
  state: LexicalState,
): LexicalTransition | undefined {
  return state === "code" ? codeTransition(source, index) : nonCodeTransition(source, index, state);
}

function maskTransition(current: LexicalState, transition: LexicalTransition): boolean {
  return current !== "code" || transition.state !== "code" || transition.consumed > 1;
}

/** Masks comments and string/template contents while preserving offsets and line breaks. */
function codeProjection(source: string): string {
  const projected: string[] = new Array<string>(source.length);
  let state: LexicalState = "code";
  for (let index = 0; index < source.length; ) {
    const current = state;
    const transition = nextLexicalState(source, index, state);
    const consumed = transition?.consumed ?? 1;
    state = transition?.state ?? state;
    for (let offset = 0; offset < consumed; offset += 1) {
      const char = source[index + offset] ?? "";
      projected[index + offset] =
        maskTransition(current, { consumed, state }) && char !== "\n" ? " " : char;
    }
    index += consumed;
  }
  return projected.join("");
}

function codeBounds(line: string): { readonly start: number; readonly end: number } | undefined {
  const start = line.search(/\S/u);
  if (start < 0) return undefined;
  let end = line.length;
  while (end > start && /\s/u.test(line[end - 1] ?? "")) end -= 1;
  return { start, end };
}

function validMappingParts(key: string, helper: string, argumentsText: string): boolean {
  return (
    IDENTIFIER.test(key) &&
    IDENTIFIER.test(helper) &&
    !argumentsText.includes("(") &&
    !argumentsText.includes(")")
  );
}

function mappingEntry(
  line: string,
  projectedLine: string,
  index: number,
): MappingEntry | undefined {
  const bounds = codeBounds(projectedLine);
  if (bounds === undefined) return undefined;
  const trimmed = line.slice(bounds.start, bounds.end);
  const projected = projectedLine.slice(bounds.start, bounds.end);
  const normalized = trimmed.endsWith(",") ? trimmed.slice(0, -1).trimEnd() : trimmed;
  const projectedNormalized = projected.endsWith(",")
    ? projected.slice(0, -1).trimEnd()
    : projected;
  const separator = projectedNormalized.indexOf(":");
  const open = projectedNormalized.indexOf("(", separator + 1);
  if (separator <= 0 || open <= separator || !projectedNormalized.endsWith(")")) return undefined;
  const key = normalized.slice(0, separator).trim();
  const helper = normalized.slice(separator + 1, open).trim();
  const argumentsText = normalized.slice(open + 1, -1).trim();
  if (!validMappingParts(key, helper, argumentsText)) return undefined;
  return { key, helper, argumentsText, line: index + 1 };
}

function mappingEntries(source: string): readonly MappingEntry[] {
  const entries: MappingEntry[] = [];
  const projectedLines = codeProjection(source).split("\n");
  for (const [index, line] of source.split("\n").entries()) {
    const entry = mappingEntry(line, projectedLines[index] ?? "", index);
    if (entry !== undefined) entries.push(entry);
  }
  return entries;
}

function uniqueEntriesByKey(entries: readonly MappingEntry[]): ReadonlyMap<string, MappingEntry> {
  const grouped = new Map<string, MappingEntry[]>();
  for (const entry of entries) grouped.set(entry.key, [...(grouped.get(entry.key) ?? []), entry]);
  return new Map(
    [...grouped].flatMap(([key, matches]) =>
      matches.length === 1 && matches[0] !== undefined ? [[key, matches[0]]] : [],
    ),
  );
}

function identifierTerms(identifier: string): readonly string[] {
  return identifier
    .replace(/([a-z\d])([A-Z])/gu, "$1 $2")
    .split(/[^A-Za-z\d]+/u)
    .filter((term) => term !== "")
    .map((term) => term.toLowerCase());
}

function helperMatchesKey(helper: string, key: string): boolean {
  const helperTerms = identifierTerms(helper);
  const keyTerms = identifierTerms(key);
  return helperTerms.some((_, start) =>
    keyTerms.every((term, offset) => helperTerms[start + offset] === term),
  );
}

function isExactCrossover(
  leftBase: MappingEntry,
  rightBase: MappingEntry,
  leftHead: MappingEntry,
  rightHead: MappingEntry,
): boolean {
  return (
    leftBase.helper !== rightBase.helper &&
    helperMatchesKey(leftBase.helper, leftBase.key) &&
    !helperMatchesKey(leftBase.helper, rightBase.key) &&
    helperMatchesKey(rightBase.helper, rightBase.key) &&
    !helperMatchesKey(rightBase.helper, leftBase.key) &&
    leftHead.helper === rightBase.helper &&
    rightHead.helper === leftBase.helper &&
    leftHead.argumentsText === leftBase.argumentsText &&
    rightHead.argumentsText === rightBase.argumentsText
  );
}

function literalMapping(
  line: string,
  projected: string,
): readonly [key: string, value: string] | undefined {
  const bounds = codeBounds(projected);
  if (bounds === undefined) return undefined;
  const segment = line.slice(bounds.start, bounds.end).replace(/,\s*$/u, "");
  const separator = projected.slice(bounds.start, bounds.end).indexOf(":");
  if (separator <= 0) return undefined;
  const key = segment.slice(0, separator).trim();
  const value = segment.slice(separator + 1).trim();
  if (!IDENTIFIER.test(key) || value.length < 2) return undefined;
  const quote = value[0];
  const literal = value.slice(1, -1);
  if ((quote !== '"' && quote !== "'") || value.at(-1) !== quote || !IDENTIFIER.test(literal)) {
    return undefined;
  }
  return [key, literal];
}

function literalMappings(source: string): ReadonlyMap<string, string> {
  const values = new Map<string, string[]>();
  const projectedLines = codeProjection(source).split("\n");
  for (const [index, line] of source.split("\n").entries()) {
    const mapping = literalMapping(line, projectedLines[index] ?? "");
    if (mapping === undefined) continue;
    const [key, literal] = mapping;
    values.set(key, [...(values.get(key) ?? []), literal]);
  }
  return new Map(
    [...values].flatMap(([key, matches]) =>
      matches.length === 1 && matches[0] !== undefined ? [[key, matches[0]]] : [],
    ),
  );
}

function hasExplicitCrossMap(source: string, leftKey: string, rightKey: string): boolean {
  const mappings = literalMappings(source);
  return mappings.get(leftKey) === rightKey && mappings.get(rightKey) === leftKey;
}

interface MappingTransition {
  readonly base: MappingEntry;
  readonly head: MappingEntry;
}

function uniqueTransitionsByHelpers(
  baseByKey: ReadonlyMap<string, MappingEntry>,
  headByKey: ReadonlyMap<string, MappingEntry>,
): ReadonlyMap<string, MappingTransition> {
  const grouped = new Map<string, MappingTransition[]>();
  for (const [key, base] of baseByKey) {
    const head = headByKey.get(key);
    if (head === undefined || head.helper === base.helper) continue;
    const transition = `${base.helper}\0${head.helper}`;
    grouped.set(transition, [...(grouped.get(transition) ?? []), { base, head }]);
  }
  return new Map(
    [...grouped].flatMap(([key, matches]) =>
      matches.length === 1 && matches[0] !== undefined ? [[key, matches[0]]] : [],
    ),
  );
}

export function isParallelMappingCandidatePath(path: string): boolean {
  const dot = path.lastIndexOf(".");
  return dot >= 0 && EXECUTABLE_EXTENSIONS.has(path.slice(dot).toLowerCase());
}

/**
 * Finds only exact two-way swaps established by the file's own base mapping. Ambiguous duplicate
 * keys, computed values, changed arguments, and merely unfamiliar helper names stay silent.
 */
export function detectParallelMappingCrossovers(
  base: string,
  head: string,
): readonly ParallelMappingCrossover[] {
  const baseByKey = uniqueEntriesByKey(mappingEntries(base));
  const headByKey = uniqueEntriesByKey(mappingEntries(head));
  const transitions = uniqueTransitionsByHelpers(baseByKey, headByKey);
  const crossovers: ParallelMappingCrossover[] = [];
  const consumed = new Set<string>();
  for (const [transitionKey, left] of transitions) {
    if (consumed.has(transitionKey)) continue;
    const reverseKey = `${left.head.helper}\0${left.base.helper}`;
    const right = transitions.get(reverseKey);
    if (
      right === undefined ||
      right.base.key === left.base.key ||
      !isExactCrossover(left.base, right.base, left.head, right.head) ||
      hasExplicitCrossMap(head, left.base.key, right.base.key)
    ) {
      continue;
    }
    consumed.add(transitionKey);
    consumed.add(reverseKey);
    crossovers.push({
      leftKey: left.base.key,
      rightKey: right.base.key,
      leftHelper: left.head.helper,
      rightHelper: right.head.helper,
      line: Math.min(left.head.line, right.head.line),
    });
  }
  return crossovers;
}

/** Publication-safe, circumstance-first prose for one proven crossover. */
export function describeParallelMappingCrossover(crossover: ParallelMappingCrossover): string {
  return (
    "Restore each mapping's matching helper.\n\n" +
    `When \`${crossover.leftKey}\` calls \`${crossover.leftHelper}\` while ` +
    `\`${crossover.rightKey}\` calls \`${crossover.rightHelper}\`, each output reports the ` +
    "other sibling's state. The base version establishes the opposite key-to-helper pairing, " +
    "and the shown arguments did not change."
  );
}
