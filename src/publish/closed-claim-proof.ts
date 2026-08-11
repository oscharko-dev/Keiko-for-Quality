import type { JudgeableFinding, VerificationEvidenceRef } from "./substantiate.js";

/**
 * A tiny closed set of source semantics that can be proven from the exact reviewed blob.
 *
 * These proofs exist for contracts where asking a language model to restate the runtime rule adds
 * variance but no information. Candidate prose may select a proof shape; it cannot supply the
 * source rows, changed-line binding, Map identity, caught binding, or absence of the guard that
 * licenses the result. Anything outside these deliberately narrow shapes stays on the ordinary
 * Truth -> Challenge -> Falsifier path.
 */
export interface ClosedClaimProof {
  readonly evidenceRefs: readonly VerificationEvidenceRef[];
}

interface HeadLine {
  readonly line: number;
  readonly text: string;
  readonly changed: boolean;
}

const HEAD_ROW = /^H:([1-9]\d*)\| (.*)$/u;
const CHANGED_HEAD_ROW = /^D:H:([1-9]\d*)\| \+(.*)$/u;
const IDENTIFIER = /^[A-Za-z_$][\w$]*$/u;
const MAX_CLAIM_CHARS = 8_192;

function headLines(evidence: string): readonly HeadLine[] {
  const source = new Map<number, string>();
  const changed = new Set<number>();
  for (const row of evidence.split("\n")) {
    const head = HEAD_ROW.exec(row);
    if (head?.[1] !== undefined && head[2] !== undefined) {
      source.set(Number(head[1]), head[2]);
      continue;
    }
    const diff = CHANGED_HEAD_ROW.exec(row);
    if (diff?.[1] !== undefined) changed.add(Number(diff[1]));
  }
  return [...source]
    .sort(([left], [right]) => left - right)
    .map(([line, text]) => ({ line, text, changed: changed.has(line) }));
}

function refsAt(line: number): readonly VerificationEvidenceRef[] {
  return [
    `D:H:${String(line)}` as VerificationEvidenceRef,
    `H:${String(line)}` as VerificationEvidenceRef,
  ];
}

function insideFinding(line: number, finding: JudgeableFinding): boolean {
  return line >= finding.startLine && line <= finding.endLine;
}

function escaped(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, String.raw`\$&`);
}

function sinkUsesCaughtBinding(text: string, binding: string): boolean {
  const argument = escaped(binding);
  const sink = [
    String.raw`(?:window\.)?reportError`,
    "(?:captureException|captureError|reportException|recordException)",
    String.raw`(?:console|logger|telemetry|diagnostics?)\.(?:error|exception|report|record)`,
  ].join("|");
  return new RegExp(String.raw`\b(?:${sink})\s*\(\s*${argument}\s*(?:[,)]|$)`, "u").test(text);
}

function disclosureClaim(content: string): boolean {
  const claim = content.slice(0, MAX_CLAIM_CHARS);
  return (
    /(?:saniti[sz]|redact|leak|expos|secret|sensitive)/iu.test(claim) &&
    /(?:error|exception|report|log|telemetry|parser)/iu.test(claim)
  );
}

function catchBindingNearFinding(finding: JudgeableFinding, line: HeadLine): string | undefined {
  if (line.line < finding.startLine - 8 || line.line > finding.endLine) return undefined;
  const caught = /\bcatch\s*\(\s*([A-Za-z_$][\w$]*)\s*\)\s*\{/u.exec(line.text)?.[1];
  return caught !== undefined && IDENTIFIER.test(caught) ? caught : undefined;
}

function caughtSinkAfter(
  finding: JudgeableFinding,
  lines: readonly HeadLine[],
  startIndex: number,
  binding: string,
): HeadLine | undefined {
  for (const candidate of lines.slice(startIndex + 1, startIndex + 10)) {
    if (/^\s*\}/u.test(candidate.text)) return undefined;
    if (!candidate.changed || !insideFinding(candidate.line, finding)) continue;
    if (sinkUsesCaughtBinding(candidate.text, binding)) return candidate;
  }
  return undefined;
}

function catchDisclosureProof(
  finding: JudgeableFinding,
  lines: readonly HeadLine[],
): ClosedClaimProof | undefined {
  if (!disclosureClaim(finding.content)) return undefined;

  for (const [index, line] of lines.entries()) {
    const caught = catchBindingNearFinding(finding, line);
    if (caught === undefined) continue;
    const sink = caughtSinkAfter(finding, lines, index, caught);
    if (sink !== undefined) return { evidenceRefs: refsAt(sink.line) };
  }
  return undefined;
}

interface MapWrite {
  readonly receiver: string;
  readonly key: string;
  readonly line: HeadLine;
}

function mapWriteAtFinding(
  finding: JudgeableFinding,
  lines: readonly HeadLine[],
): MapWrite | undefined {
  for (const line of lines) {
    if (!line.changed || !insideFinding(line.line, finding)) continue;
    const call = /\b([A-Za-z_$][\w$]*)\.set\(/u.exec(line.text);
    if (call?.[1] === undefined) continue;
    const argumentsText = line.text.slice(call.index + call[0].length);
    const comma = argumentsText.indexOf(",");
    if (comma < 0) continue;
    const key = argumentsText.slice(0, comma).trim();
    if (!/^[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*$/u.test(key)) continue;
    return { receiver: call[1], key, line };
  }
  return undefined;
}

function isShownMap(lines: readonly HeadLine[], write: MapWrite): boolean {
  const receiver = escaped(write.receiver);
  const declaration = new RegExp(
    String.raw`\b(?:const|let|var)\s+${receiver}\s*=\s*new\s+Map(?:\s*<[^;]+>)?\s*\(`,
    "u",
  );
  return lines.some((line) => line.line <= write.line.line && declaration.test(line.text));
}

function hasShownDuplicateGuard(lines: readonly HeadLine[], write: MapWrite): boolean {
  const receiver = escaped(write.receiver);
  const key = escaped(write.key).replace(/\s+/gu, String.raw`\s*`);
  const directGuard = new RegExp(String.raw`\b${receiver}\.has\(\s*${key}\s*\)`, "u");
  const nearbyGuard = /\b(?:duplicate|unique|seen)\b.*\b(?:has|throw|return|reject)/iu;
  return lines.some(
    (line) =>
      line.line < write.line.line &&
      line.line >= write.line.line - 24 &&
      (directGuard.test(line.text) || nearbyGuard.test(line.text)),
  );
}

function duplicateMapProof(
  finding: JudgeableFinding,
  lines: readonly HeadLine[],
): ClosedClaimProof | undefined {
  const claim = finding.content.slice(0, MAX_CLAIM_CHARS);
  if (!/\bduplicate[sd]?\b/iu.test(claim)) return undefined;
  if (!/\b(?:overwrit\w*|discard\w*|collision\w*|reject\w*)\b/iu.test(claim)) return undefined;
  const write = mapWriteAtFinding(finding, lines);
  if (write === undefined || !isShownMap(lines, write) || hasShownDuplicateGuard(lines, write)) {
    return undefined;
  }
  return { evidenceRefs: refsAt(write.line.line) };
}

/** Return a proof only when exact changed source licenses one of the closed claim contracts. */
export function closedClaimProof(
  finding: JudgeableFinding,
  evidence: string,
): ClosedClaimProof | undefined {
  const lines = headLines(evidence);
  return catchDisclosureProof(finding, lines) ?? duplicateMapProof(finding, lines);
}
