import { afterEach, describe, expect, it, vi } from "vitest";

import {
  ReviewDeadlineExceeded,
  boundedReviewTimeoutMs,
  remainingReviewTimeMs,
  requireReviewTime,
  startReviewDeadline,
} from "./review-deadline.js";

afterEach(() => {
  vi.useRealTimers();
});

describe("whole-review deadline", () => {
  it("keeps one absolute instant while every stage receives only the shrinking remainder", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-09T10:00:00Z"));
    const deadline = startReviewDeadline(30);

    expect(remainingReviewTimeMs(deadline)).toBe(30_000);
    expect(boundedReviewTimeoutMs(deadline, 45_000)).toBe(30_000);

    vi.advanceTimersByTime(12_345);
    expect(remainingReviewTimeMs(deadline)).toBe(17_655);
    expect(boundedReviewTimeoutMs(deadline, 5_000)).toBe(5_000);
  });

  it("refuses new work at the boundary", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-09T10:00:00Z"));
    const deadline = startReviewDeadline(1);
    vi.advanceTimersByTime(1_000);

    expect(() => requireReviewTime(deadline)).toThrow(ReviewDeadlineExceeded);
  });
});
