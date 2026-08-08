import { test } from "node:test";
import assert from "node:assert/strict";

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
  assert.ok((svg.match(/>—</g) ?? []).length === 3);
});

test("theme=light switches the palette", async () => {
  const svg = await (await get("/widget/oscharko-dev/Keiko.svg?theme=light")).text();
  assert.match(svg, /#ffffff/);
});

test("a second identical request is served from the cache", async () => {
  cacheStore.clear();
  await get("/widget/oscharko-dev/Keiko.svg");
  assert.equal(cacheStore.size, 1);
  const again = await get("/widget/oscharko-dev/Keiko.svg");
  assert.equal(again.status, 200);
});
