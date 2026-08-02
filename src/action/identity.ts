import type { Diagnostics } from "../diagnostics/sink.js";
import { GitHubClient } from "../github/client.js";
import { mintInstallationToken } from "../github/app-token.js";

export interface ResolvedIdentity {
  readonly client: GitHubClient;
  /** The login GitHub will attribute this reviewer's comments to. */
  readonly login: string;
  readonly usedApp: boolean;
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
    return { client: new GitHubClient(apiBase, minted.token), login: minted.login, usedApp: true };
  }

  const token = (env.INPUT_GITHUB_TOKEN ?? "").trim();
  if (token === "") {
    diagnostics.record("publish.identity_unresolved");
    return undefined;
  }

  const client = new GitHubClient(apiBase, token);
  const login = (await client.resolveViewerLogin()) ?? "github-actions[bot]";
  diagnostics.record("publish.identity_resolved");
  return { client, login, usedApp: false };
}
