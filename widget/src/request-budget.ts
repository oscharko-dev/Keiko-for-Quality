/**
 * One hard GitHub-request budget for a complete card render, including App authentication.
 *
 * A reservation is taken synchronously before the underlying fetch starts. That makes the cap
 * safe even when run and finding collection execute concurrently: JavaScript cannot interleave
 * two reservations between the comparison and increment. The first refused request marks the
 * budget exhausted; callers then discard every collected metric rather than expose a partial
 * population as an exact value.
 */

export const MAX_GITHUB_REQUESTS = 50;

export interface GitHubRequestBudget {
  readonly fetch: typeof fetch;
  readonly exhausted: boolean;
  readonly used: number;
}

export function createGitHubRequestBudget(fetchImpl: typeof fetch): GitHubRequestBudget {
  let used = 0;
  let exhausted = false;

  const budgetedFetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    if (used >= MAX_GITHUB_REQUESTS) {
      exhausted = true;
      throw new Error("GitHub request budget exhausted");
    }
    used += 1;
    return fetchImpl(input, init);
  };

  return {
    fetch: budgetedFetch,
    get exhausted(): boolean {
      return exhausted;
    },
    get used(): number {
      return used;
    },
  };
}
