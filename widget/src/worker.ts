/**
 * The quality.keiko.dev edge adapter: routes, auth resolution, caching — and nothing clever.
 *
 * Everything with judgement in it lives in `card.ts` (pure rendering) and `collect.ts` (bounded
 * data collection); this file only wires them to a fetch handler. It is written against the
 * WebWorker lib plus the two Cloudflare-specific declarations in `cf.d.ts`, so the repository
 * needs no worker-types dependency and `tsc -p widget` stays a full check.
 *
 * Contract:
 * - `GET /widget/<owner>/<repo>.svg?theme=dark|light` renders the card. Owners outside
 *   `KQ_ALLOWED_OWNERS` get 404 — this service holds a GitHub credential and answers on a
 *   public URL, so who it will spend that credential on is an allowlist, not a default.
 * - Auth prefers `KQ_GITHUB_TOKEN` (a fine-grained read-only PAT, the simple deployment),
 *   falling back to the GitHub App pair `KQ_APP_ID`/`KQ_APP_PRIVATE_KEY`. With neither, or on
 *   any collection failure, the card renders with em dashes — the service degrades to honest
 *   ignorance, never to a 500 in a README.
 * - Responses carry `s-maxage=600`: GitHub's image proxy (camo) honours it, so one cache miss costs
 *   at most 50 API calls, including App authentication, regardless of README traffic.
 */

import { renderCard } from "./card.js";
import type { CardData, CardTheme } from "./card.js";
import { collectCardData } from "./collect.js";
import { installationToken } from "./github-app.js";
import { createGitHubRequestBudget } from "./request-budget.js";
import type { GitHubRequestBudget } from "./request-budget.js";

export interface Env {
  readonly KQ_GITHUB_TOKEN?: string;
  readonly KQ_APP_ID?: string;
  readonly KQ_APP_PRIVATE_KEY?: string;
  /** Comma-separated owner allowlist; absent means the service answers for no one. */
  readonly KQ_ALLOWED_OWNERS?: string;
}

const CACHE_SECONDS = 600;
const OWNER_RE = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;
const REPO_RE = /^[A-Za-z0-9._-]{1,100}$/;

interface WidgetPath {
  readonly owner: string;
  readonly repo: string;
}

function parseWidgetPath(pathname: string): WidgetPath | undefined {
  const match = /^\/widget\/([^/]+)\/([^/]+)\.svg$/.exec(pathname);
  if (match === null) return undefined;
  const [, owner, repo] = match;
  if (owner === undefined || repo === undefined) return undefined;
  if (!OWNER_RE.test(owner) || !REPO_RE.test(repo)) return undefined;
  return { owner, repo };
}

function allowedOwner(owner: string, env: Env): boolean {
  const allowed = (env.KQ_ALLOWED_OWNERS ?? "")
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry !== "");
  return allowed.some((entry) => entry.toLowerCase() === owner.toLowerCase());
}

async function resolveToken(
  env: Env,
  owner: string,
  repo: string,
  requests: GitHubRequestBudget,
  nowMs: number,
): Promise<string | undefined> {
  if (env.KQ_GITHUB_TOKEN !== undefined && env.KQ_GITHUB_TOKEN !== "") return env.KQ_GITHUB_TOKEN;
  if (env.KQ_APP_ID === undefined || env.KQ_APP_PRIVATE_KEY === undefined) return undefined;
  return installationToken(
    env.KQ_APP_ID,
    env.KQ_APP_PRIVATE_KEY,
    owner,
    repo,
    requests,
    Math.floor(nowMs / 1000),
  );
}

function svgResponse(svg: string): Response {
  return new Response(svg, {
    headers: {
      "content-type": "image/svg+xml; charset=utf-8",
      "cache-control": `public, max-age=300, s-maxage=${String(CACHE_SECONDS)}`,
      "x-content-type-options": "nosniff",
    },
  });
}

async function renderWidget(env: Env, url: URL, path: WidgetPath): Promise<Response> {
  const theme: CardTheme = url.searchParams.get("theme") === "light" ? "light" : "dark";
  const nowMs = Date.now();
  const requests = createGitHubRequestBudget(fetch);
  const token = await resolveToken(env, path.owner, path.repo, requests, nowMs);
  let data: CardData = { owner: path.owner, repo: path.repo };
  if (token !== undefined) {
    data = await collectCardData(path.owner, path.repo, token, requests, nowMs);
  }
  return svgResponse(renderCard(data, theme));
}

async function handle(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  const url = new URL(request.url);
  if (url.pathname === "/healthz") return new Response("ok\n");
  if (url.pathname === "/") {
    return Response.redirect("https://github.com/oscharko-dev/Keiko-for-Quality", 302);
  }
  const path = parseWidgetPath(url.pathname);
  if (path === undefined || !allowedOwner(path.owner, env)) {
    return new Response("not found\n", { status: 404 });
  }
  const cacheKey = new Request(url.toString());
  const cached = await caches.default.match(cacheKey);
  if (cached !== undefined) return cached;
  const response = await renderWidget(env, url, path);
  ctx.waitUntil(caches.default.put(cacheKey, response.clone()));
  return response;
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    if (request.method !== "GET" && request.method !== "HEAD") {
      return new Response("method not allowed\n", { status: 405 });
    }
    return handle(request, env, ctx);
  },
};
