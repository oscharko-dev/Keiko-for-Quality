import { createVerify, generateKeyPairSync } from "node:crypto";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { createAppJwt, mintInstallationToken } from "./app-token.js";

/**
 * `app-token.ts` mints this reviewer's own posting identity — a GitHub App installation token built
 * from a hand-rolled JWT (RS256 over a PEM private key) and three further API calls (`/app` for the
 * slug, the repository's `/installation` for the installation id, then `/access_tokens` to exchange
 * for the short-lived token). It is the reviewer's whole posting identity, and it had zero test
 * coverage before this file — a named freeze-backlog gap (epic #26).
 *
 * Hermetic throughout, mirroring `github/client.test.ts` and `engine/acquire.test.ts`: save the real
 * `globalThis.fetch`, install a scripted stub, restore the original in `afterEach`. The RSA key pair
 * is generated fresh in-memory with `node:crypto`'s `generateKeyPairSync` in `beforeAll` — never a
 * fixture key committed to disk — and reused across tests, since RSA-SHA256 signing (PKCS#1 v1.5, not
 * randomized PSS padding) is deterministic for the same key and input, which several tests below rely
 * on directly to recompute the exact JWT a given call must have used.
 *
 * `node:timers/promises` is mocked the same way `github/client.test.ts` mocks it for the identical
 * reason: `apiJson`'s retry loop (v0.13.0) really does call `setTimeout`-backed `delay` between
 * attempts, and without this a retry test would wait out the real linear backoff (seconds) instead
 * of completing instantly.
 */
const { sleepCalls, sleepStub } = vi.hoisted(() => {
  const sleepCalls: number[] = [];
  return {
    sleepCalls,
    sleepStub: (ms: number): Promise<void> => {
      sleepCalls.push(ms);
      return Promise.resolve();
    },
  };
});
vi.mock("node:timers/promises", () => ({ setTimeout: sleepStub }));

let privateKeyPem: string;
let publicKeyPem: string;

beforeAll(() => {
  const pair = generateKeyPairSync("rsa", {
    modulusLength: 2048,
    publicKeyEncoding: { type: "spki", format: "pem" },
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
  });
  privateKeyPem = pair.privateKey;
  publicKeyPem = pair.publicKey;
});

const APP_ID = "418773";
const NOW = 1_700_000_000;

function base64UrlDecode(segment: string): Buffer {
  const padded = segment.replace(/-/g, "+").replace(/_/g, "/");
  const padding = padded.length % 4 === 0 ? "" : "=".repeat(4 - (padded.length % 4));
  return Buffer.from(padded + padding, "base64");
}

describe("createAppJwt", () => {
  it("produces three dot-separated base64url segments (no padding, no + or /)", () => {
    const jwt = createAppJwt(APP_ID, privateKeyPem, NOW);
    const segments = jwt.split(".");
    expect(segments).toHaveLength(3);
    for (const segment of segments) {
      expect(segment.length).toBeGreaterThan(0);
      expect(segment).toMatch(/^[A-Za-z0-9_-]+$/);
    }
  });

  it("header carries alg RS256 and typ JWT", () => {
    const jwt = createAppJwt(APP_ID, privateKeyPem, NOW);
    const [headerSegment] = jwt.split(".");
    const header: unknown = JSON.parse(base64UrlDecode(headerSegment!).toString("utf8"));
    expect(header).toEqual({ alg: "RS256", typ: "JWT" });
  });

  it("payload carries iss/iat/exp within the documented clock-skew and lifetime bounds", () => {
    const jwt = createAppJwt(APP_ID, privateKeyPem, NOW);
    const [, payloadSegment] = jwt.split(".");
    const payload: unknown = JSON.parse(base64UrlDecode(payloadSegment!).toString("utf8"));
    // Backdated one minute (documented: runner clocks drift, and GitHub rejects a future `iat`) and
    // forward nine minutes, for a 600-second total lifetime at GitHub's documented 10-minute maximum.
    expect(payload).toEqual({ iss: APP_ID, iat: NOW - 60, exp: NOW + 540 });
  });

  it("tracks the supplied nowSeconds rather than reading the wall clock", () => {
    const jwt = createAppJwt(APP_ID, privateKeyPem, NOW + 3600);
    const [, payloadSegment] = jwt.split(".");
    const payload: unknown = JSON.parse(base64UrlDecode(payloadSegment!).toString("utf8"));
    expect(payload).toEqual({ iss: APP_ID, iat: NOW + 3600 - 60, exp: NOW + 3600 + 540 });
  });

  it("signs RS256 over header.payload, verifiable against the matching public key", () => {
    const jwt = createAppJwt(APP_ID, privateKeyPem, NOW);
    const [headerSegment, payloadSegment, signatureSegment] = jwt.split(".");
    const verifier = createVerify("RSA-SHA256");
    verifier.update(`${headerSegment!}.${payloadSegment!}`);
    verifier.end();
    expect(verifier.verify(publicKeyPem, base64UrlDecode(signatureSegment!))).toBe(true);
  });

  it("does not verify against an unrelated key pair", () => {
    const other = generateKeyPairSync("rsa", {
      modulusLength: 2048,
      publicKeyEncoding: { type: "spki", format: "pem" },
      privateKeyEncoding: { type: "pkcs8", format: "pem" },
    });
    const jwt = createAppJwt(APP_ID, privateKeyPem, NOW);
    const [headerSegment, payloadSegment, signatureSegment] = jwt.split(".");
    const verifier = createVerify("RSA-SHA256");
    verifier.update(`${headerSegment!}.${payloadSegment!}`);
    verifier.end();
    expect(verifier.verify(other.publicKey, base64UrlDecode(signatureSegment!))).toBe(false);
  });

  it("is deterministic for identical inputs", () => {
    expect(createAppJwt(APP_ID, privateKeyPem, NOW)).toBe(createAppJwt(APP_ID, privateKeyPem, NOW));
  });

  /**
   * `signer.sign(privateKey)` (`node:crypto`) runs with no surrounding try/catch in `createAppJwt`,
   * so whatever Node itself throws for a bad key propagates verbatim. Pinned by actually triggering
   * each case rather than assumed: an empty string and a non-PEM string fail through two different
   * Node code paths with two different, stable error codes.
   */
  describe("malformed or empty private key", () => {
    it("rejects an empty string the way node:crypto rejects it", () => {
      expect(() => createAppJwt(APP_ID, "", NOW)).toThrow(
        expect.objectContaining({ code: "ERR_CRYPTO_SIGN_KEY_REQUIRED" }),
      );
    });

    it("rejects a non-PEM string the way node:crypto rejects it", () => {
      expect(() => createAppJwt(APP_ID, "not-a-pem-at-all", NOW)).toThrow(
        expect.objectContaining({ code: "ERR_OSSL_UNSUPPORTED" }),
      );
    });

    it("never lets the malformed key's own bytes leak into the thrown error", () => {
      const marker = "TOTALLY-UNIQUE-KEY-BYTES-4f8a1c";
      const badKey = `-----BEGIN GARBAGE-----\n${marker}\n-----END GARBAGE-----`;
      let caught: unknown;
      try {
        createAppJwt(APP_ID, badKey, NOW);
      } catch (error) {
        caught = error;
      }
      expect(caught).toBeInstanceOf(Error);
      expect((caught as Error).message).not.toContain(marker);
      expect((caught as Error).stack ?? "").not.toContain(marker);
    });
  });
});

interface RequestLog {
  readonly url: string;
  readonly method: string;
  readonly authorization: string | undefined;
}

function urlOf(input: string | URL | Request): string {
  return typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status });
}

/** Answers call N with `responses[N]`; an unscripted extra call rejects instead of hanging silently
 *  or falling through to a stale response — the same "fail loudly" shape `acquire.test.ts`'s
 *  `stubFetchForbidden` uses for the zero-call case. */
function scriptedFetch(responses: readonly Response[]): {
  readonly fetch: typeof fetch;
  readonly calls: RequestLog[];
} {
  const calls: RequestLog[] = [];
  const handler = ((input: string | URL | Request, init?: RequestInit) => {
    const index = calls.length;
    const headers = init?.headers as Record<string, string> | undefined;
    calls.push({
      url: urlOf(input),
      method: init?.method ?? "GET",
      authorization: headers?.authorization,
    });
    const response = responses[index];
    if (response === undefined) {
      return Promise.reject(
        new Error(`unscripted fetch call #${String(index + 1)}: ${urlOf(input)}`),
      );
    }
    return Promise.resolve(response);
  }) as typeof fetch;
  return { fetch: handler, calls };
}

/** Unwraps a rejected promise into its `Error`, for tests that need to inspect the message or code
 *  rather than just assert that a rejection happened. */
async function captureRejection(promise: Promise<unknown>): Promise<Error> {
  try {
    await promise;
  } catch (error) {
    return error as Error;
  }
  throw new Error("expected the promise to reject, but it resolved");
}

const API_BASE = "https://api.github.test";
const OWNER = "acme";
const REPO = "widget";

describe("mintInstallationToken", () => {
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    sleepCalls.length = 0;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("happy path: three calls in order, each bearing the same app JWT, ending in the installation token", async () => {
    const { fetch: stub, calls } = scriptedFetch([
      jsonResponse({ slug: "keiko-for-quality" }),
      jsonResponse({ id: 555 }),
      jsonResponse({ token: "installation-token-abc123" }),
    ]);
    globalThis.fetch = stub;

    const identity = await mintInstallationToken(API_BASE, APP_ID, privateKeyPem, OWNER, REPO, NOW);

    expect(identity).toEqual({
      token: "installation-token-abc123",
      login: "keiko-for-quality[bot]",
    });

    expect(calls).toHaveLength(3);
    expect(calls[0]).toMatchObject({ url: `${API_BASE}/app`, method: "GET" });
    expect(calls[1]).toMatchObject({
      url: `${API_BASE}/repos/${OWNER}/${REPO}/installation`,
      method: "GET",
    });
    expect(calls[2]).toMatchObject({
      url: `${API_BASE}/app/installations/555/access_tokens`,
      method: "POST",
    });

    // All three calls authenticate as the App itself (the JWT), never the installation token that
    // does not exist yet until the third call returns it.
    const expectedJwt = createAppJwt(APP_ID, privateKeyPem, NOW);
    expect(calls[0]?.authorization).toBe(`Bearer ${expectedJwt}`);
    expect(calls[1]?.authorization).toBe(`Bearer ${expectedJwt}`);
    expect(calls[2]?.authorization).toBe(`Bearer ${expectedJwt}`);
  });

  describe("non-OK responses", () => {
    it("fails the way the module fails on a non-OK /app response, calling fetch only once", async () => {
      const { fetch: stub, calls } = scriptedFetch([jsonResponse({}, 404)]);
      globalThis.fetch = stub;

      const error = await captureRejection(
        mintInstallationToken(API_BASE, APP_ID, privateKeyPem, OWNER, REPO, NOW),
      );

      expect(error.message).toBe("github app api 404");
      expect(calls).toHaveLength(1);
    });

    it("fails the way the module fails on a non-OK installations response, never reaching the token exchange", async () => {
      const { fetch: stub, calls } = scriptedFetch([
        jsonResponse({ slug: "keiko-for-quality" }),
        jsonResponse({}, 404),
      ]);
      globalThis.fetch = stub;

      const error = await captureRejection(
        mintInstallationToken(API_BASE, APP_ID, privateKeyPem, OWNER, REPO, NOW),
      );

      expect(error.message).toBe("github app api 404");
      expect(calls).toHaveLength(2);
    });

    /**
     * A 500 is retryable (v0.13.0) — the retry loop `github/client.ts`'s `requestUrl` already
     * applies to every other GitHub API call this reviewer makes. The token exchange call itself
     * now retries up to `MAX_ATTEMPTS` (3) times before giving up, so the fixture scripts three
     * consecutive 500s for it, and the total call count is 2 (slug + installation) + 3 (the
     * exhausted retry loop) = 5.
     */
    it("retries the token-exchange call up to three times before failing, after all attempts were exhausted", async () => {
      const { fetch: stub, calls } = scriptedFetch([
        jsonResponse({ slug: "keiko-for-quality" }),
        jsonResponse({ id: 555 }),
        jsonResponse({}, 500),
        jsonResponse({}, 500),
        jsonResponse({}, 500),
      ]);
      globalThis.fetch = stub;

      const error = await captureRejection(
        mintInstallationToken(API_BASE, APP_ID, privateKeyPem, OWNER, REPO, NOW),
      );

      expect(error.message).toBe("github app api 500");
      expect(calls).toHaveLength(5);
      // Linear backoff, no `retry-after` header on any of the three 500s — the loop sleeps after
      // every attempt including the last, since it does not know attempt 3 is the final one until
      // the FOURTH loop condition check fails.
      expect(sleepCalls).toEqual([1000, 2000, 3000]);
    });

    it("recovers from a transient 500 on the token-exchange call without failing the mint", async () => {
      const { fetch: stub, calls } = scriptedFetch([
        jsonResponse({ slug: "keiko-for-quality" }),
        jsonResponse({ id: 555 }),
        jsonResponse({}, 500),
        jsonResponse({ token: "ghs_minted", expires_at: "2026-01-01T00:00:00Z" }),
      ]);
      globalThis.fetch = stub;

      const identity = await mintInstallationToken(
        API_BASE,
        APP_ID,
        privateKeyPem,
        OWNER,
        REPO,
        NOW,
      );

      expect(identity.token).toBe("ghs_minted");
      expect(calls).toHaveLength(4);
    });

    it("does not retry a 404 on the token-exchange call — the same unretryable status the earlier stages already pin", async () => {
      const { fetch: stub, calls } = scriptedFetch([
        jsonResponse({ slug: "keiko-for-quality" }),
        jsonResponse({ id: 555 }),
        jsonResponse({}, 404),
      ]);
      globalThis.fetch = stub;

      const error = await captureRejection(
        mintInstallationToken(API_BASE, APP_ID, privateKeyPem, OWNER, REPO, NOW),
      );

      expect(error.message).toBe("github app api 404");
      expect(calls).toHaveLength(3);
      expect(sleepCalls).toEqual([]);
    });
  });

  describe("missing or malformed response fields", () => {
    it("rejects a response with no usable slug", async () => {
      globalThis.fetch = scriptedFetch([jsonResponse({})]).fetch;
      const error = await captureRejection(
        mintInstallationToken(API_BASE, APP_ID, privateKeyPem, OWNER, REPO, NOW),
      );
      expect(error.message).toBe("github app slug unavailable");
    });

    it("rejects a slug that is not a string", async () => {
      globalThis.fetch = scriptedFetch([jsonResponse({ slug: 12345 })]).fetch;
      const error = await captureRejection(
        mintInstallationToken(API_BASE, APP_ID, privateKeyPem, OWNER, REPO, NOW),
      );
      expect(error.message).toBe("github app slug unavailable");
    });

    it("rejects a response with no usable installation id", async () => {
      globalThis.fetch = scriptedFetch([
        jsonResponse({ slug: "keiko-for-quality" }),
        jsonResponse({}),
      ]).fetch;
      const error = await captureRejection(
        mintInstallationToken(API_BASE, APP_ID, privateKeyPem, OWNER, REPO, NOW),
      );
      expect(error.message).toBe("github app installation unavailable");
    });

    it("rejects an installation id that is not a number", async () => {
      globalThis.fetch = scriptedFetch([
        jsonResponse({ slug: "keiko-for-quality" }),
        jsonResponse({ id: "555" }),
      ]).fetch;
      const error = await captureRejection(
        mintInstallationToken(API_BASE, APP_ID, privateKeyPem, OWNER, REPO, NOW),
      );
      expect(error.message).toBe("github app installation unavailable");
    });

    it("rejects a response with no usable token", async () => {
      globalThis.fetch = scriptedFetch([
        jsonResponse({ slug: "keiko-for-quality" }),
        jsonResponse({ id: 555 }),
        jsonResponse({}),
      ]).fetch;
      const error = await captureRejection(
        mintInstallationToken(API_BASE, APP_ID, privateKeyPem, OWNER, REPO, NOW),
      );
      expect(error.message).toBe("github app token unavailable");
    });

    it("rejects a token that is not a string", async () => {
      globalThis.fetch = scriptedFetch([
        jsonResponse({ slug: "keiko-for-quality" }),
        jsonResponse({ id: 555 }),
        jsonResponse({ token: 999 }),
      ]).fetch;
      const error = await captureRejection(
        mintInstallationToken(API_BASE, APP_ID, privateKeyPem, OWNER, REPO, NOW),
      );
      expect(error.message).toBe("github app token unavailable");
    });
  });

  describe("a malformed private key propagated through the whole mint flow", () => {
    it("throws node:crypto's own error before ever calling fetch", async () => {
      let fetchCalled = false;
      globalThis.fetch = (() => {
        fetchCalled = true;
        return Promise.reject(new Error("fetch must not be called when signing fails"));
      }) as typeof fetch;

      const error = await captureRejection(
        mintInstallationToken(API_BASE, APP_ID, "", OWNER, REPO, NOW),
      );

      expect((error as Error & { code?: string }).code).toBe("ERR_CRYPTO_SIGN_KEY_REQUIRED");
      expect(fetchCalled).toBe(false);
    });

    it("never lets the malformed key's own bytes leak, even through the full mint flow", async () => {
      const marker = "TOTALLY-UNIQUE-KEY-BYTES-9c2e77";
      const badKey = `-----BEGIN GARBAGE-----\n${marker}\n-----END GARBAGE-----`;
      globalThis.fetch = (() =>
        Promise.reject(new Error("fetch must not be called when signing fails"))) as typeof fetch;

      const error = await captureRejection(
        mintInstallationToken(API_BASE, APP_ID, badKey, OWNER, REPO, NOW),
      );

      expect(error.message).not.toContain(marker);
      expect(error.stack ?? "").not.toContain(marker);
    });
  });

  describe("redaction: the private key and the minted JWT never leak", () => {
    it("does not appear in a successful result, and the result's token is not the JWT", async () => {
      globalThis.fetch = scriptedFetch([
        jsonResponse({ slug: "keiko-for-quality" }),
        jsonResponse({ id: 555 }),
        jsonResponse({ token: "installation-token-abc123" }),
      ]).fetch;

      const identity = await mintInstallationToken(
        API_BASE,
        APP_ID,
        privateKeyPem,
        OWNER,
        REPO,
        NOW,
      );
      const expectedJwt = createAppJwt(APP_ID, privateKeyPem, NOW);
      const serialized = JSON.stringify(identity);

      expect(identity.token).not.toBe(expectedJwt);
      expect(serialized).not.toContain(privateKeyPem);
      expect(serialized).not.toContain(expectedJwt);
      for (const segment of expectedJwt.split(".")) {
        expect(serialized).not.toContain(segment);
      }
    });

    /** Every failure shape above, revisited with one extra check: whatever the module throws, it
     *  never carries the key or the JWT that produced it. Reuses the same response fixtures rather
     *  than re-deriving them — the per-scenario tests above already pin each exact message; this one
     *  only needs to prove the redaction property holds across every failure shape. */
    it("is absent from every non-OK-response and missing-field error message above", async () => {
      const expectedJwt = createAppJwt(APP_ID, privateKeyPem, NOW);
      const responseSets: (readonly Response[])[] = [
        [jsonResponse({}, 404)],
        [jsonResponse({ slug: "keiko-for-quality" }), jsonResponse({}, 404)],
        [
          jsonResponse({ slug: "keiko-for-quality" }),
          jsonResponse({ id: 555 }),
          jsonResponse({}, 500),
        ],
        [jsonResponse({})],
        [jsonResponse({ slug: "keiko-for-quality" }), jsonResponse({})],
        [jsonResponse({ slug: "keiko-for-quality" }), jsonResponse({ id: 555 }), jsonResponse({})],
      ];

      for (const responses of responseSets) {
        globalThis.fetch = scriptedFetch(responses).fetch;
        const error = await captureRejection(
          mintInstallationToken(API_BASE, APP_ID, privateKeyPem, OWNER, REPO, NOW),
        );
        expect(error.message).not.toContain(privateKeyPem);
        expect(error.message).not.toContain(expectedJwt);
        for (const segment of expectedJwt.split(".")) {
          expect(error.message).not.toContain(segment);
        }
      }
    });
  });
});
