/**
 * Library surface.
 *
 * The action is one consumer of this module, not a separate implementation, so the local entry
 * point and CI run the same code paths — a divergence between them would make local reproduction
 * of a CI result meaningless.
 */
export { performReview } from "./review.js";
export type { ReviewRequest, ReviewReport, ReviewOutcome } from "./review.js";

/**
 * The publication-free decomposition of the pipeline above (issue #95): same inventory, engine,
 * classification, and dedup/sanitization behaviour as `performReview`, minus the two GitHub-only
 * stages `request.client` feeds there (head currency and publication). Findings come back as data —
 * `performLocalReview` never constructs a `GitHubClient` and never makes a GitHub API call.
 */
export { performLocalReview } from "./review.js";
export type { LocalReviewRequest, LocalReviewReport } from "./review.js";

export {
  appendEntries,
  computeKey,
  computePathSetDigest,
  lookup,
  readStore,
  serializeStore,
  SUPPORTED_STORE_SCHEMA,
} from "./cache/review-cache.js";
export type {
  BlobId,
  CacheEntry,
  CacheKey,
  CacheStore,
  ModelId,
  Protocol,
} from "./cache/review-cache.js";

export { loadReviewProfile, parseReviewProfile, compileProfile } from "./config/profile.js";
export type { ReviewProfile, CompiledProfile } from "./config/profile.js";

export { parseRuntimeConfig } from "./config/runtime.js";
export type { RuntimeConfig, ProviderProtocol } from "./config/runtime.js";

export { createDiagnostics, createSilentDiagnostics } from "./diagnostics/sink.js";
export type { Diagnostics, DiagnosticRecord } from "./diagnostics/sink.js";
export { REASON_CODES } from "./diagnostics/reason-codes.js";
export type { ReasonCode } from "./diagnostics/reason-codes.js";

export { GitHubClient } from "./github/client.js";
export { ENGINE_PIN } from "./engine/pinned-release.js";
export { sanitizeFindingBody } from "./publish/sanitize.js";
export { evaluateEligibility } from "./action/eligibility.js";
