import { test } from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";

/**
 * The adapter's security surface: method gate, path validation, the owner allowlist, and the
 * degradation to an em-dash card when no credential is configured — which is also the one
 * render path that touches no network, so these tests run hermetically. Node has no `caches`
 * global; the stub below stands in for Cloudflare's edge cache and records writes.
 */

const cacheStore = new Map();
globalThis.caches = {
  default: {
    match: async (request) => cacheStore.get(request.url),
    put: async (request, response) => {
      cacheStore.set(request.url, response);
    },
  },
};

const { default: worker } = await import("../src/worker.ts");

const ENV = { KQ_ALLOWED_OWNERS: "oscharko-dev" };
const ctx = { waitUntil: () => {} };
const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const APP_PRIVATE_KEY = privateKey.export({ type: "pkcs8", format: "pem" }).toString();

function get(path, env = ENV) {
  return worker.fetch(new Request(`https://quality.keiko.dev${path}`), env, ctx);
}

test("non-GET methods are refused", async () => {
  const response = await worker.fetch(
    new Request("https://quality.keiko.dev/widget/oscharko-dev/Keiko.svg", { method: "POST" }),
    ENV,
    ctx,
  );
  assert.equal(response.status, 405);
});

test("healthz answers and root redirects to the repository", async () => {
  assert.equal((await get("/healthz")).status, 200);
  const root = await get("/");
  assert.equal(root.status, 302);
  assert.match(root.headers.get("location"), /github\.com\/oscharko-dev\/Keiko-for-Quality/);
});

test("unknown paths and malformed names are 404", async () => {
  assert.equal((await get("/widget/oscharko-dev/Keiko")).status, 404);
  assert.equal((await get("/widget/..%2f../secret.svg")).status, 404);
  assert.equal((await get("/anything")).status, 404);
});

test("owners outside the allowlist are 404, case-insensitively inside it", async () => {
  assert.equal((await get("/widget/somebody-else/repo.svg")).status, 404);
  assert.equal((await get("/widget/OSCHARKO-DEV/Keiko.svg")).status, 200);
  assert.equal((await get("/widget/oscharko-dev/Keiko.svg", {})).status, 404);
});

test("without a credential the card renders with em dashes and caches", async () => {
  cacheStore.clear();
  const response = await get("/widget/oscharko-dev/Keiko.svg");
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type"), /image\/svg\+xml/);
  assert.match(response.headers.get("cache-control"), /s-maxage=600/);
  const svg = await response.text();
  assert.match(svg, /oscharko-dev\/Keiko/);
  assert.ok((svg.match(/>—</g) ?? []).length === 6);
});

test("theme=light switches the palette", async () => {
  const svg = await (await get("/widget/oscharko-dev/Keiko.svg?theme=light")).text();
  assert.match(svg, /#FFFFFF/);
});

test("a configured PAT drives collection through the real pipeline", async () => {
  const calls = [];
  globalThis.fetch = async (url) => {
    calls.push(String(url));
    return new Response("no", { status: 500 });
  };
  cacheStore.clear();
  const response = await get("/widget/oscharko-dev/Keiko.svg", { ...ENV, KQ_GITHUB_TOKEN: "tok" });
  assert.equal(response.status, 200);
  assert.ok(calls.length >= 2);
  const svg = await response.text();
  assert.ok((svg.match(/>—</g) ?? []).length === 5);
  assert.match(svg, />DATA AS OF · /);
});

test("App credentials that cannot sign degrade to the em-dash card, not a 500", async () => {
  globalThis.fetch = async () => {
    throw new Error("unreachable");
  };
  cacheStore.clear();
  const response = await get("/widget/oscharko-dev/Keiko.svg", {
    ...ENV,
    KQ_APP_ID: "1",
    KQ_APP_PRIVATE_KEY: "not a key",
  });
  assert.equal(response.status, 200);
  assert.match(await response.text(), />—</);
});

test("App authentication and concurrent collection share one fifty-request ceiling", async () => {
  let executed = 0;
  globalThis.fetch = async (url) => {
    executed += 1;
    const requestUrl = String(url);
    if (requestUrl.endsWith("/repos/oscharko-dev/BudgetRepo/installation")) {
      return Response.json({ id: 77 });
    }
    if (requestUrl.endsWith("/app/installations/77/access_tokens")) {
      return Response.json({ token: "ghs_budget" });
    }
    if (requestUrl.includes("/actions/workflows?")) {
      const page = Number(new URL(requestUrl).searchParams.get("page"));
      const offset = (page - 1) * 100;
      return Response.json({
        total_count: 1_000,
        workflows: Array.from({ length: 100 }, (_, index) => ({
          id: offset + index + 1,
          path: `.github/workflows/keiko-for-quality-${String(offset + index + 1)}.yml`,
        })),
      });
    }
    if (requestUrl.includes("/actions/workflows/") && requestUrl.includes("/runs?")) {
      return Response.json({ total_count: 0, workflow_runs: [] });
    }
    if (requestUrl.endsWith("/graphql")) {
      return Response.json({
        data: {
          search: {
            issueCount: 0,
            pageInfo: { hasNextPage: false, endCursor: null },
            nodes: [],
          },
        },
      });
    }
    return new Response("no", { status: 404 });
  };
  cacheStore.clear();
  const response = await get("/widget/oscharko-dev/BudgetRepo.svg", {
    ...ENV,
    KQ_APP_ID: "1",
    KQ_APP_PRIVATE_KEY: APP_PRIVATE_KEY,
  });
  assert.equal(response.status, 200);
  assert.equal(executed, 50);
  assert.equal(((await response.text()).match(/>—</g) ?? []).length, 6);
});

test("a second identical request is served from the cache", async () => {
  cacheStore.clear();
  await get("/widget/oscharko-dev/Keiko.svg");
  assert.equal(cacheStore.size, 1);
  const again = await get("/widget/oscharko-dev/Keiko.svg");
  assert.equal(again.status, 200);
});
