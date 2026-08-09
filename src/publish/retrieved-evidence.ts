import type { RepositoryFollowUpContext } from "./repository-context.js";
import {
  evidenceProvenanceKey,
  type EvidenceProvenanceKey,
  type RetrievedEvidence,
} from "./substantiate.js";

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
): RetrievedEvidence {
  const byPath = new Map<string, { line: number; text: string }[]>();
  for (const entry of context.entries) {
    if (knownProvenance.has(evidenceProvenanceKey(entry.path, context.side, entry.line))) continue;
    const lines = byPath.get(entry.path) ?? [];
    lines.push({ line: entry.line, text: entry.content });
    byPath.set(entry.path, lines);
  }
  return {
    chunks: [...byPath].slice(0, 3).map(([path, lines]) => ({ path, side: context.side, lines })),
  };
}
