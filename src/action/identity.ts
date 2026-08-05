import type { Diagnostics } from "../diagnostics/sink.js";
import { GitHubClient } from "../github/client.js";
import { mintInstallationToken } from "../github/app-token.js";

export interface ResolvedIdentity {
  readonly client: GitHubClient;
  /** The login GitHub will attribute this reviewer's comments to. */
  readonly login: string;
  /**
   * True only when `login` is provably exclusive to this reviewer — nothing else in the
   * repository can author a comment under it. The App branch is always exclusive (an
   * installation's own identity). The plain-token branch is exclusive only when
   * `resolveViewerLogin` actually resolved a distinct login for the configured token; the
   * documented fallback (`github-actions[bot]`, the shared login every default-`GITHUB_TOKEN`
   * workflow in the repository authors under) is exactly the shared-identity case this flag exists
   * to distinguish.
   *
   * Read-only findings (suppression, deduplication) already tolerate a shared identity — the worst
   * case is a missed suppression, which the module doc above already names as "a real weakening."
   * A WRITE against another author's content is a different class of risk: resolving a thread this
   * reviewer did not actually author would be acting on someone else's conversation under an
   * identity this run cannot prove is exclusively its own. See `resolveSupersededOwnNotices`'s own
   * caller in `review.ts` for the one place this flag gates something.
   */
  readonly exclusive: boolean;
}

/**
 * Builds the client with the environment's own GraphQL endpoint when Actions supplied one.
 *
 * Actions sets `GITHUB_GRAPHQL_URL` to the correct host on GitHub Enterprise Server; `GitHubClient`
 * already falls back to github.com's endpoint on its own, so this only forwards a value that exists
 * rather than ever passing `undefined` where the constructor expects a string.
 */
function buildClient(apiBase: string, token: string, env: NodeJS.ProcessEnv): GitHubClient {
  const graphqlBase = env.GITHUB_GRAPHQL_URL;
  return graphqlBase === undefined
    ? new GitHubClient(apiBase, token)
    : new GitHubClient(apiBase, token, graphqlBase);
}

/**
 * Establishes who this run posts as.
 *
 * Two modes are supported, and the difference matters for more than presentation.
 *
 * With a GitHub App the reviewer has an identity nothing else in the repository can assume, which
 * is what makes marker-based deduplication trustworthy: a suppression decision is only safe if the
 * comment carrying the marker could only have been written by this reviewer.
 *
 * With a plain token the reviewer falls back to whatever that token authors as — in a workflow,
 * the shared `github-actions[bot]`. Deduplication still verifies authorship, but the identity is
 * shared, so a marker could in principle be authored by another workflow in the same repository.
 * That is a real weakening, and it is why the App is the documented configuration.
 */
export async function resolveIdentity(
  apiBase: string,
  env: NodeJS.ProcessEnv,
  owner: string,
  repo: string,
  diagnostics: Diagnostics,
  nowSeconds: number,
): Promise<ResolvedIdentity | undefined> {
  const appId = (env.INPUT_APP_ID ?? "").trim();
  const privateKey = (env.INPUT_APP_PRIVATE_KEY ?? "").trim();

  if (appId !== "" && privateKey !== "") {
    const minted = await mintInstallationToken(apiBase, appId, privateKey, owner, repo, nowSeconds);
    diagnostics.record("publish.identity_resolved");
    return {
      client: buildClient(apiBase, minted.token, env),
      login: minted.login,
      exclusive: true,
    };
  }

  const token = (env.INPUT_GITHUB_TOKEN ?? "").trim();
  if (token === "") {
    diagnostics.record("publish.identity_unresolved");
    return undefined;
  }

  const client = buildClient(apiBase, token, env);
  // Exclusive only when the token's own viewer login actually resolved — the fallback below is the
  // shared login every default-`GITHUB_TOKEN` workflow in the repository authors under.
  const resolvedLogin = await client.resolveViewerLogin();
  const login = resolvedLogin ?? "github-actions[bot]";
  diagnostics.record("publish.identity_resolved");
  return { client, login, exclusive: resolvedLogin !== undefined };
}
