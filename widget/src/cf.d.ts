/**
 * The two Cloudflare Workers surfaces this service touches beyond the standard WebWorker lib,
 * declared by hand so the repository carries no @cloudflare/workers-types dependency for a
 * sub-200-line deployable. If the adapter ever grows past these, take the real types package.
 */

/** Cloudflare's per-invocation context: only `waitUntil` is used (cache writes). */
declare interface ExecutionContext {
  waitUntil(promise: Promise<unknown>): void;
}

/** Cloudflare exposes the default edge cache as `caches.default`; the lib type does not know it. */
declare interface CacheStorage {
  readonly default: Cache;
}
