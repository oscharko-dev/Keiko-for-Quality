import { test } from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync, createVerify } from "node:crypto";

import { appJwt, installationToken } from "../src/github-app.ts";
import { createGitHubRequestBudget } from "../src/request-budget.ts";

/**
 * The JWT here is verified with Node's own crypto against a freshly generated key pair — the
 * test proves a real RS256 signature, not that two home-grown encoders agree with each other.
 */

const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const PEM = privateKey.export({ type: "pkcs8", format: "pem" }).toString();

function fromBase64url(part) {
  return Buffer.from(part.replaceAll("-", "+").replaceAll("_", "/"), "base64");
}

test("appJwt produces a verifiable RS256 token with the App claims", async () => {
  const now = 1_754_600_000;
  const jwt = await appJwt("12345", PEM, now);
  const [header, payload, signature] = jwt.split(".");
  assert.deepEqual(JSON.parse(fromBase64url(header).toString()), { alg: "RS256", typ: "JWT" });
  assert.deepEqual(JSON.parse(fromBase64url(payload).toString()), {
    iat: now - 30,
    exp: now + 600,
    iss: "12345",
  });
  const verifier = createVerify("RSA-SHA256");
  verifier.update(`${header}.${payload}`);
  assert.equal(verifier.verify(publicKey, fromBase64url(signature)), true);
});

test("installationToken walks installation lookup then token mint", async () => {
  const seen = [];
  const token = await installationToken(
    "12345",
    PEM,
    "o",
    "r",
    createGitHubRequestBudget(async (url, init) => {
      seen.push({ url: String(url), method: init?.method ?? "GET" });
      if (String(url).endsWith("/repos/o/r/installation")) {
        return Response.json({ id: 77 });
      }
      if (String(url).endsWith("/app/installations/77/access_tokens")) {
        return Response.json({ token: "ghs_abc" });
      }
      return new Response("no", { status: 404 });
    }),
    1_754_600_000,
  );
  assert.equal(token, "ghs_abc");
  assert.deepEqual(
    seen.map((s) => s.method),
    ["GET", "POST"],
  );
});

test("installationToken degrades to undefined on any failure", async () => {
  assert.equal(
    await installationToken(
      "1",
      PEM,
      "o",
      "r",
      createGitHubRequestBudget(async () => new Response("no", { status: 404 })),
      0,
    ),
    undefined,
  );
  assert.equal(
    await installationToken(
      "1",
      "not a key",
      "o",
      "r",
      createGitHubRequestBudget(async () => Response.json({})),
      0,
    ),
    undefined,
  );
});
