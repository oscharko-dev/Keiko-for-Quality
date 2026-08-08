/**
 * GitHub App authentication for the widget service, dependency-free on WebCrypto.
 *
 * The widget reads Actions runs and review threads; a GitHub App installation token is the
 * least-privilege way to do that at real rate limits, and the Keiko for Quality App already
 * exists. RS256 is signed with `crypto.subtle` — available in Cloudflare Workers and Node 20+ —
 * so this module carries no jsonwebtoken dependency and the whole service stays auditable in
 * one sitting. A personal access token can stand in for local runs (`worker.ts` prefers it when
 * configured), which is also what the tests use: nothing here is mocked into pretending it
 * signed something it did not.
 */

const encoder = new TextEncoder();

function base64url(bytes: ArrayBuffer | Uint8Array): string {
  const view = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let binary = "";
  for (const b of view) binary += String.fromCodePoint(b);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
}

/** PEM (PKCS#8) to the raw DER bytes `crypto.subtle.importKey` wants — over a plain
 * `ArrayBuffer`, which is what the lib's `BufferSource` requires. */
function pemToDer(pem: string): Uint8Array<ArrayBuffer> {
  const body = pem
    .replace(/-----BEGIN [A-Z ]+-----/, "")
    .replace(/-----END [A-Z ]+-----/, "")
    .replace(/\s+/g, "");
  const binary = atob(body);
  const bytes = new Uint8Array(new ArrayBuffer(binary.length));
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.codePointAt(i) ?? 0;
  return bytes;
}

/** A short-lived App JWT (10 minutes, 30 s clock skew allowance backwards). */
export async function appJwt(
  appId: string,
  privateKeyPem: string,
  nowSeconds: number,
): Promise<string> {
  const header = base64url(encoder.encode(JSON.stringify({ alg: "RS256", typ: "JWT" })));
  const payload = base64url(
    encoder.encode(JSON.stringify({ iat: nowSeconds - 30, exp: nowSeconds + 600, iss: appId })),
  );
  const key = await crypto.subtle.importKey(
    "pkcs8",
    pemToDer(privateKeyPem),
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign(
    "RSASSA-PKCS1-v1_5",
    key,
    encoder.encode(`${header}.${payload}`),
  );
  return `${header}.${payload}.${base64url(signature)}`;
}

/**
 * The installation token for one repository, minted through the App JWT. Failures return
 * `undefined` rather than throwing: the widget's contract is "render what you know", and an
 * auth hiccup renders the em-dash card, never a 500.
 */
export async function installationToken(
  appId: string,
  privateKeyPem: string,
  owner: string,
  repo: string,
  fetchImpl: typeof fetch,
  nowSeconds: number,
): Promise<string | undefined> {
  try {
    const jwt = await appJwt(appId, privateKeyPem, nowSeconds);
    const headers = {
      authorization: `Bearer ${jwt}`,
      accept: "application/vnd.github+json",
      "user-agent": "keiko-quality-widget",
    };
    const install = await fetchImpl(`https://api.github.com/repos/${owner}/${repo}/installation`, {
      headers,
    });
    if (!install.ok) return undefined;
    const { id } = (await install.json()) as { id?: number };
    if (typeof id !== "number") return undefined;
    const token = await fetchImpl(
      `https://api.github.com/app/installations/${String(id)}/access_tokens`,
      { method: "POST", headers },
    );
    if (!token.ok) return undefined;
    const { token: value } = (await token.json()) as { token?: string };
    return typeof value === "string" ? value : undefined;
  } catch {
    return undefined;
  }
}
