import type { RepositoryFollowUpContext } from "./repository-context.js";
import type { ClosedRuntimeFact } from "./runtime-fact-catalog.js";
import {
  evidenceProvenanceKey,
  runtimeFactProvenanceKey,
  type ContractChallengeAxis,
  type EvidenceProvenanceKey,
  type RetrievedEvidence,
} from "./substantiate.js";

const MAX_RETRIEVED_SOURCES = 3;
const MAX_RUNTIME_SIGNAL_CHARS = 8_192;
const NULLISH_SIGNAL = /\b(?:null(?:ish)?|undefined)\b/iu;
const RUNTIME_BEHAVIOR_SIGNAL =
  /\b(?:object\s+spread|spread(?:s|ing)?|throw(?:s|ing)?|typeerror)\b/iu;

/** A bounded, deterministic gate: candidate prose can request detection, never choose a fact. */
export function requestsClosedRuntimeFacts(
  findingContent: string,
  challengeAxis: ContractChallengeAxis | undefined,
): boolean {
  if (challengeAxis === "runtime") return true;
  const bounded = findingContent.slice(0, MAX_RUNTIME_SIGNAL_CHARS);
  return NULLISH_SIGNAL.test(bounded) && RUNTIME_BEHAVIOR_SIGNAL.test(bounded);
}

/**
 * Shared production/replay adapter for the verifier's one follow-up retrieval.
 *
 * The repository collector may return several kinds of exact-commit sightings. Facts already
 * visible to an earlier role are removed before the stable three-path cap, so repeated leading
 * paths cannot hide a later independent challenge. Shipped review and historical replay hand the
 * verifier the identical structured boundary.
 */
export function toRetrievedEvidence(
  context: RepositoryFollowUpContext,
  knownProvenance: ReadonlySet<EvidenceProvenanceKey> = new Set(),
  runtimeFacts: readonly ClosedRuntimeFact[] = [],
): RetrievedEvidence {
  const facts = runtimeFacts
    .filter((fact) => !knownProvenance.has(runtimeFactProvenanceKey(fact)))
    .slice(0, MAX_RETRIEVED_SOURCES);
  const byPath = new Map<string, { line: number; text: string }[]>();
  for (const entry of context.entries) {
    if (knownProvenance.has(evidenceProvenanceKey(entry.path, context.side, entry.line))) continue;
    const lines = byPath.get(entry.path) ?? [];
    lines.push({ line: entry.line, text: entry.content });
    byPath.set(entry.path, lines);
  }
  const chunks = [...byPath]
    .slice(0, MAX_RETRIEVED_SOURCES - facts.length)
    .map(([path, lines]) => ({ path, side: context.side, lines }));
  return {
    chunks,
    ...(facts.length === 0 ? {} : { facts }),
  };
}
