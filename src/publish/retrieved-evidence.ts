import type { RepositoryEvidenceContext } from "./evidence.js";
import type { RetrievedEvidence } from "./substantiate.js";

/**
 * Shared production/replay adapter for the verifier's one follow-up retrieval.
 *
 * The repository collector may return several kinds of exact-HEAD sightings. The verifier owns
 * the final caps and validation; this adapter only groups the stable first three paths so both
 * shipped review and historical replay hand it the identical structured boundary.
 */
export function toRetrievedEvidence(context: RepositoryEvidenceContext): RetrievedEvidence {
  const byPath = new Map<string, { line: number; text: string }[]>();
  for (const entry of context.entries) {
    const lines = byPath.get(entry.path) ?? [];
    lines.push({ line: entry.line, text: entry.content });
    byPath.set(entry.path, lines);
  }
  return {
    chunks: [...byPath].slice(0, 3).map(([path, lines]) => ({ path, side: "H", lines })),
  };
}
