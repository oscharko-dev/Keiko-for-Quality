import { createSign } from "node:crypto";

/**
 * Mints a short-lived GitHub App installation token.
 *
 * Implemented directly against `node:crypto` rather than pulled from a package: this is roughly
 * forty lines of well-specified signing, and the alternative is adding a dependency tree to the
 * one component that handles a private key.
 *
 * The reviewer needs its own identity — not a shared one — because deduplication only suppresses a
 * repost when the existing conversation was authored by *this* reviewer. Under a shared identity,
 * any other workflow in the repository could author a comment carrying a valid-looking marker and
 * silence a real finding.
 */

/**
 * Base64url (RFC 7515 §2, the JWS encoding): standard base64 with `+`/`/` swapped for `-`/`_` and
 * the `=` padding dropped. Applied to all three JWT segments, the signature included.
 *
 * The padding strip is `(?<!=)=+$`, not the plain `=+$` it replaced. The two match exactly the same
 * thing — the leftmost index from which `=` runs to end of string IS the start of the final run of
 * `=`, and that is the only index the lookbehind admits — but `=+$` is super-linear (Sonar S8786):
 * nothing anchors its start, so the engine retries at every index inside a run of `=`, re-expanding
 * the run before `$` fails, which is quadratic in the run's length. The lookbehind lets a match
 * start only where a run starts, so the scan is linear. Same technique, for the same reason, as
 * `publish/sanitize.ts`'s INLINE_SPAN. This closed an ambiguity rather than a live denial of
 * service: base64 padding is at most two characters, so nothing reaching this function could make
 * the quadratic case bite.
 */
function base64Url(input: Buffer | string): string {
  return Buffer.from(input)
    .toString("base64")
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/(?<!=)=+$/, "");
}

/**
 * Builds the app JWT.
 *
 * `iat` is backdated by a minute because GitHub rejects a token whose issued-at is in the future,
 * and runner clocks drift.
 */
export function createAppJwt(appId: string, privateKey: string, nowSeconds: number): string {
  const header = base64Url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const payload = base64Url(
    JSON.stringify({ iat: nowSeconds - 60, exp: nowSeconds + 540, iss: appId }),
  );
  const signingInput = `${header}.${payload}`;
  const signer = createSign("RSA-SHA256");
  signer.update(signingInput);
  signer.end();
  return `${signingInput}.${base64Url(signer.sign(privateKey))}`;
}

export interface AppIdentity {
  readonly token: string;
  /** The login findings will be authored under, for example `keiko-for-quality[bot]`. */
  readonly login: string;
}

interface AppResponse {
  readonly slug?: unknown;
}

interface InstallationResponse {
  readonly id?: unknown;
}

interface TokenResponse {
  readonly token?: unknown;
}

async function apiJson(url: string, bearer: string, method = "GET"): Promise<unknown> {
  const response = await fetch(url, {
    method,
    headers: {
      authorization: `Bearer ${bearer}`,
      accept: "application/vnd.github+json",
      "x-github-api-version": "2022-11-28",
      "user-agent": "keiko-for-quality",
    },
  });
  if (!response.ok) throw new Error(`github app api ${String(response.status)}`);
  return await response.json();
}

/**
 * Exchanges the App credentials for an installation token scoped to one repository.
 *
 * The App slug is read from the same credentials, so the identity used for deduplication is the
 * identity GitHub will actually attribute the comments to — not a name supplied by configuration
 * that could drift from reality.
 */
export async function mintInstallationToken(
  apiBase: string,
  appId: string,
  privateKey: string,
  owner: string,
  repo: string,
  nowSeconds: number,
): Promise<AppIdentity> {
  const jwt = createAppJwt(appId, privateKey, nowSeconds);
  const app = (await apiJson(`${apiBase}/app`, jwt)) as AppResponse;
  const slug = typeof app.slug === "string" ? app.slug : undefined;
  if (slug === undefined) throw new Error("github app slug unavailable");

  const installation = (await apiJson(
    `${apiBase}/repos/${owner}/${repo}/installation`,
    jwt,
  )) as InstallationResponse;
  const id = typeof installation.id === "number" ? installation.id : undefined;
  if (id === undefined) throw new Error("github app installation unavailable");

  const issued = (await apiJson(
    `${apiBase}/app/installations/${String(id)}/access_tokens`,
    jwt,
    "POST",
  )) as TokenResponse;
  const token = typeof issued.token === "string" ? issued.token : undefined;
  if (token === undefined) throw new Error("github app token unavailable");

  return { token, login: `${slug}[bot]` };
}
