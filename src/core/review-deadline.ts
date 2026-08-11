/**
 * One absolute wall-clock boundary for an entire review.
 *
 * The value is created exactly once by `performReview`/`performLocalReview` and then passed through
 * every model-bearing stage. Keeping an absolute instant, rather than handing each stage a fresh
 * duration, is what makes retries and post-generation checks share the same ceiling.
 */
export interface ReviewDeadline {
  readonly expiresAtMs: number;
}

/** A private control-flow signal: callers turn it into an incomplete report, never a clean one. */
export class ReviewDeadlineExceeded extends Error {
  public constructor() {
    super("review deadline exceeded");
    this.name = "ReviewDeadlineExceeded";
  }
}

export function startReviewDeadline(reviewTimeoutSeconds: number): ReviewDeadline {
  return { expiresAtMs: Date.now() + reviewTimeoutSeconds * 1_000 };
}

/** Exact remaining duration, rounded down and clamped so it can safely become a timeout. */
export function remainingReviewTimeMs(deadline: ReviewDeadline): number {
  return Math.max(0, Math.trunc(deadline.expiresAtMs - Date.now()));
}

export function reviewDeadlineExpired(deadline: ReviewDeadline): boolean {
  return remainingReviewTimeMs(deadline) === 0;
}

/** Returns the real remainder or stops the current stage before it starts another call. */
export function requireReviewTime(deadline: ReviewDeadline): number {
  const remaining = remainingReviewTimeMs(deadline);
  if (remaining === 0) throw new ReviewDeadlineExceeded();
  return remaining;
}

/** A stage may narrow the shared remainder, never refresh or widen it. */
export function boundedReviewTimeoutMs(deadline: ReviewDeadline, stageMaximumMs: number): number {
  return Math.min(requireReviewTime(deadline), Math.max(1, Math.trunc(stageMaximumMs)));
}
