import type { InventoryItem } from "../inventory/classify.js";
import type { EngineFinding } from "../engine/result.js";
import type { ReviewCommentInput } from "../github/client.js";
import type { CommitSha } from "../core/brands.js";

/**
 * Candidate anchors for one finding, in the order they should be attempted.
 *
 * GitHub accepts a line-level review comment only on a line that is part of the diff, and it
 * answers with a 422 otherwise. Rather than predicting which lines qualify — which would mean
 * reimplementing the diff hunks GitHub computed — the publisher walks this ladder and lets the API
 * arbitrate. The cost is at most two extra rejected requests for an awkward finding; the benefit is
 * that a finding about a removed line lands on the deletion side instead of being dropped.
 */
export function placementLadder(
  finding: EngineFinding,
  item: InventoryItem | undefined,
  headSha: CommitSha,
): readonly ReviewCommentInput[] {
  const base = { body: "", commitId: headSha, path: finding.path } as const;
  const fileLevel: ReviewCommentInput = { ...base };

  // A deleted file has no right-hand side to anchor to, and an unknown path was never part of the
  // diff at all — GitHub rejects a line comment on either, on both sides, every time, so neither
  // case has a line-level rung worth the round trip.
  if (
    item === undefined ||
    item.classification.kind === "reviewed-as-deletion" ||
    item.status === "D"
  ) {
    return [fileLevel];
  }

  const line = finding.endLine > 0 ? finding.endLine : finding.startLine;
  if (line <= 0) return [fileLevel];

  const startLine =
    finding.startLine > 0 && finding.startLine < line ? finding.startLine : undefined;
  const right: ReviewCommentInput = {
    ...base,
    line,
    side: "RIGHT",
    ...(startLine !== undefined ? { startLine } : {}),
  };
  // An added file has no pre-image at all — the LEFT rung is a guaranteed 422 for every finding on
  // one, not just an occasional miss, since GitHub has no deletion-side diff to anchor it to.
  if (item.status === "A") return [right, fileLevel];
  const left: ReviewCommentInput = { ...base, line, side: "LEFT" };
  return [right, left, fileLevel];
}

export function describePlacement(input: ReviewCommentInput): "line" | "deletion" | "file" {
  if (input.line === undefined) return "file";
  return input.side === "LEFT" ? "deletion" : "line";
}

/**
 * Tallies a fully-exhausted ladder's attempts by placement kind.
 *
 * Meaningful only once every rung has already been rejected (Keiko-for-Quality#63): the ladder
 * always ends with a file-level attempt, so this is never a partial picture of what was tried — it
 * is the complete record of every anchor kind the finding attempted, including the file-level retry,
 * before the run gave up on it. Keyed by the same three-value vocabulary `describePlacement` already
 * reports on success, and bounded to counts alone, which is what makes it safe for a diagnostic to
 * carry: never the rejection's own message, never the finding's content.
 */
export function tallyPlacementAttempts(
  ladder: readonly ReviewCommentInput[],
): Readonly<Record<string, number>> {
  const tally: Record<string, number> = {};
  for (const attempt of ladder) {
    const kind = describePlacement(attempt);
    tally[kind] = (tally[kind] ?? 0) + 1;
  }
  return tally;
}
