/**
 * Fixture review-thread data for `corpus/arena-lib.test.mjs`.
 *
 * Shaped exactly like the GraphQL `reviewThreads` connection `corpus/arena-fetch.mjs` reads (see
 * the query in that file's header), so these exercise the real "raw API shape to normalized
 * conversation" step rather than a shortcut. The pull request, paths, line numbers, and bot
 * identities are real — read from Keiko pull request #2926 on 2026-08-02 while calibrating this
 * tool. Comment bodies are NOT copied from that pull request: they are short, original sentences
 * written for this fixture that preserve the property under test (three genuine paraphrases of one
 * claim; three genuinely distinct remarks that happen to share a location) without committing any
 * bot's real generated review prose to this repository. `PR_2926_HEAD_SHA` is the real head this
 * tool measured against; see the pull request that introduced this file for the live run.
 */

export const PR_2926_HEAD_SHA = "41cf0b93421b5ea5c1be39ff680ff4d55fb2ff94";
const ROUTES_PATH = "packages/keiko-server/src/coding-context/codingContextRoutes.ts";
const SETTINGS_PATH =
  "packages/keiko-ui/src/app/components/desktop/widgets/panels/SettingsPanel.tsx";
const ADR_PATH = "docs/adr/ADR-0117-type-aware-memory-decay-semanticization.md";
const VAULT_PATH = "packages/keiko-memory-vault/src/tombstones.ts";

function comment({
  databaseId,
  login,
  typename = "Bot",
  path,
  line,
  originalLine,
  startLine = null,
  originalStartLine = null,
  createdAt,
  body,
  replyTo = null,
  commit = "092f356678aa1b2c3d4e5f60718293a4b5c6d7e8",
}) {
  return {
    databaseId,
    url: `https://github.com/oscharko-dev/Keiko/pull/2926#discussion_r${String(databaseId)}`,
    body,
    path,
    line,
    originalLine,
    startLine,
    originalStartLine,
    createdAt,
    commit: { oid: commit },
    author: login === null ? null : { login, __typename: typename },
    replyTo: replyTo === null ? null : { databaseId: replyTo },
  };
}

function thread(id, isResolved, isOutdated, comments) {
  return { id, isResolved, isOutdated, comments: { nodes: comments } };
}

/**
 * Three genuine paraphrases of one claim at `codingContextRoutes.ts:236`, from Keiko for Quality.
 * This is the pinned regression case for bug #38 (paraphrase duplicates): the normalizer must
 * collapse these three into one distinct finding plus two duplicate variants.
 */
const kfqRoutesDuplicateTrio = [
  thread("PRRT_routes_1", false, false, [
    comment({
      databaseId: 5001,
      login: "keiko-for-quality[bot]",
      path: ROUTES_PATH,
      line: null,
      originalLine: 236,
      originalStartLine: 235,
      createdAt: "2026-08-02T12:24:48Z",
      body:
        "_🐛 Correctness_ | _🟠 Major_\n\n**Restore the route's fallback connector " +
        "construction.**\n\nThe route now trusts only the injected GitHub and Jira ports and no " +
        "longer falls back to connectors built from environment configuration, so a caller that " +
        "never injects a port loses its connector and gets missing-credentials instead of a " +
        "working connection.",
    }),
  ]),
  thread("PRRT_routes_2", false, false, [
    comment({
      databaseId: 5002,
      login: "keiko-for-quality[bot]",
      path: ROUTES_PATH,
      line: null,
      originalLine: 236,
      originalStartLine: 235,
      createdAt: "2026-08-02T12:32:33Z",
      body:
        "_🐛 Correctness_ | _🟠 Major_\n\n**Keep the default connector construction when no port " +
        "is injected.**\n\nThis route now depends entirely on the injected GitHub and Jira " +
        "ports; a caller that relies on the previous fallback construction from environment " +
        "configuration will get an unconfigured connector and missing-credentials even though " +
        "its configuration is valid.",
    }),
  ]),
  thread("PRRT_routes_3", true, false, [
    comment({
      databaseId: 5003,
      login: "keiko-for-quality[bot]",
      path: ROUTES_PATH,
      line: null,
      originalLine: 236,
      originalStartLine: 235,
      createdAt: "2026-08-02T13:15:46Z",
      body:
        "_🐛 Correctness_ | _🟠 Major_\n\n**Preserve the fallback connector construction for " +
        "this route.**\n\nThe route still needs to construct GitHub and Jira connectors from " +
        "environment configuration when no port is injected; removing that fallback " +
        "construction means an existing caller now gets missing-credentials instead of a " +
        "configured connector.",
    }),
    comment({
      databaseId: 5004,
      login: "oscharko",
      typename: "User",
      path: ROUTES_PATH,
      line: 236,
      originalLine: 236,
      originalStartLine: 235,
      createdAt: "2026-08-02T14:00:00Z",
      body: "Fixed in the next push, thank you.",
      replyTo: 5003,
    }),
  ]),
];

/** CodeRabbit, at an overlapping window on the same file, corroborating the KfQ trio above. */
const coderabbitRoutesOverlap = thread("PRRT_routes_coderabbit", false, false, [
  comment({
    databaseId: 5101,
    login: "coderabbitai",
    path: ROUTES_PATH,
    line: null,
    originalLine: 243,
    originalStartLine: 235,
    createdAt: "2026-08-02T12:21:38Z",
    body:
      "_🎯 Functional Correctness_ | _🟠 Major_\n\n**`composeConnectors` no longer falls back to " +
      "environment-derived ports.**\n\nCallers that never populate the injected-port fields will " +
      "regress to an unconfigured connector.",
  }),
]);

/** Codex, overlapping the same location — together with the two above this forms an all-three cluster. */
const codexRoutesOverlap = thread("PRRT_routes_codex", false, false, [
  comment({
    databaseId: 5201,
    login: "chatgpt-codex-connector[bot]",
    path: ROUTES_PATH,
    line: null,
    originalLine: 240,
    originalStartLine: 236,
    createdAt: "2026-08-02T12:14:42Z",
    body:
      "_P1_\n\n**Fallback connector construction was removed.**\n\nProduction callers relying on " +
      "the previous default now receive `missing-credentials` even with valid configuration.",
  }),
]);

/**
 * Three genuinely distinct CodeRabbit remarks whose line windows all overlap in one hunk of
 * `SettingsPanel.tsx`. This is the negative control for the duplicate heuristic: location overlap
 * alone must not collapse them, because they are not paraphrases of each other.
 */
const coderabbitSettingsPanelDistinctTrio = [
  thread("PRRT_settings_1", false, true, [
    comment({
      databaseId: 5301,
      login: "coderabbitai",
      path: SETTINGS_PATH,
      line: null,
      originalLine: 451,
      originalStartLine: 436,
      createdAt: "2026-08-02T12:21:38Z",
      body:
        "_📐 Maintainability_ | _🟠 Major_\n\n**Reuse the existing confirm dialog affordance.**\n\n" +
        "This introduces a second confirmation pattern instead of the shared dialog the settings " +
        "surface already uses elsewhere.",
    }),
  ]),
  thread("PRRT_settings_2", false, true, [
    comment({
      databaseId: 5302,
      login: "coderabbitai",
      path: SETTINGS_PATH,
      line: null,
      originalLine: 451,
      originalStartLine: 444,
      createdAt: "2026-08-02T12:21:39Z",
      body:
        "_🩺 Stability_ | _🟠 Major_\n\n**Surface a correlation id instead of discarding the " +
        "error.**\n\nThe catch block drops the thrown error entirely, so every failure reads as " +
        "the same generic message regardless of cause.",
    }),
  ]),
  thread("PRRT_settings_3", false, false, [
    comment({
      databaseId: 5303,
      login: "coderabbitai",
      path: SETTINGS_PATH,
      line: 447,
      originalLine: 447,
      originalStartLine: 436,
      createdAt: "2026-08-02T15:19:37Z",
      body:
        "_🎯 Functional Correctness_ | _🟡 Minor_\n\n**Check the installed framework version " +
        "before relying on this hook.**\n\nThe hook used here is only available from a later " +
        "release than the one pinned in the lockfile.",
    }),
  ]),
];

/**
 * Two incomplete-review notices from Keiko for Quality on the same file, across two pushes — the
 * shape actually observed on Keiko #2926. Both must be excluded from the findings pool entirely and
 * counted only as `incompleteNotices`.
 */
const kfqIncompleteNoticePair = [
  thread("PRRT_adr_notice_1", true, false, [
    comment({
      databaseId: 5401,
      login: "keiko-for-quality[bot]",
      path: ADR_PATH,
      line: 1,
      originalLine: 1,
      createdAt: "2026-08-02T12:06:24Z",
      body:
        "_⚠️ Coverage_ | _🟠 Major_\n\n**This change was not fully reviewed.**\n\nKeiko for " +
        "Quality could not complete its review. Reason code: `settlement.incomplete.terminal_state`.",
      commit: "8945465ea6b0e701ec03235a5ef5bbb4d9b9719d",
    }),
  ]),
  thread("PRRT_adr_notice_2", true, true, [
    comment({
      databaseId: 5402,
      login: "keiko-for-quality[bot]",
      path: ADR_PATH,
      line: null,
      originalLine: 1,
      createdAt: "2026-08-02T12:32:39Z",
      body:
        "_⚠️ Coverage_ | _🟠 Major_\n\n**This change was not fully reviewed.**\n\nKeiko for " +
        "Quality could not complete its review. Reason code: `settlement.incomplete.budget_exceeded`.",
      commit: "c621e999c32695abf6db6d55b30277da5e95c9fd",
    }),
  ]),
];

/** Three CodeRabbit findings on one file at non-overlapping windows — ordinary distinct coverage. */
const coderabbitVaultDistinctFindings = [
  thread("PRRT_vault_1", false, false, [
    comment({
      databaseId: 5501,
      login: "coderabbitai",
      path: VAULT_PATH,
      line: null,
      originalLine: 52,
      originalStartLine: 51,
      createdAt: "2026-08-02T12:14:42Z",
      body: "_🎯 Functional Correctness_ | _🟡 Minor_\n\n**Guard against a negative TTL.**\n\nA caller-supplied negative value bypasses the tombstone expiry check entirely.",
    }),
  ]),
  thread("PRRT_vault_2", true, false, [
    comment({
      databaseId: 5502,
      login: "coderabbitai",
      path: VAULT_PATH,
      line: null,
      originalLine: 252,
      originalStartLine: 185,
      createdAt: "2026-08-02T15:19:37Z",
      body: "_📐 Maintainability_ | _🟡 Minor_\n\n**Extract the shared sweep loop.**\n\nThis duplicates the sweep loop already defined earlier in the same file.",
    }),
  ]),
  thread("PRRT_vault_3", false, false, [
    comment({
      databaseId: 5503,
      login: "coderabbitai",
      path: VAULT_PATH,
      line: null,
      originalLine: 291,
      originalStartLine: 266,
      createdAt: "2026-08-02T15:19:38Z",
      body: "_🩺 Stability_ | _🟡 Minor_\n\n**Log the sweep failure before continuing.**\n\nAn error from one tombstone sweep silently stops the whole batch with no diagnostic.",
    }),
  ]),
];

/** The full raw thread list for the PR #2926-shaped fixture. */
export const PR_2926_RAW_THREADS = [
  ...kfqRoutesDuplicateTrio,
  coderabbitRoutesOverlap,
  codexRoutesOverlap,
  ...coderabbitSettingsPanelDistinctTrio,
  ...kfqIncompleteNoticePair,
  ...coderabbitVaultDistinctFindings,
];

/** A second, smaller pull request fixture: one clean, non-overlapping finding per bot. */
export const PR_2924_HEAD_SHA = "da36cc152f1ba208f604046bd32b8293b442b6eb";
export const PR_2924_RAW_THREADS = [
  thread("PRRT_2924_kfq", true, false, [
    comment({
      databaseId: 6001,
      login: "keiko-for-quality",
      path: "docs/qa/keiko-for-quality.md",
      line: null,
      originalLine: 12,
      originalStartLine: 8,
      createdAt: "2026-08-02T11:04:12Z",
      body: "_📐 Maintainability_ | _🟡 Minor_\n\n**Name the schedule explicitly.**\n\nThe cron expression is easy to misread without the UTC note next to it.",
    }),
  ]),
  thread("PRRT_2924_coderabbit", false, false, [
    comment({
      databaseId: 6002,
      login: "coderabbitai",
      path: "docs/qa/keiko-for-quality.md",
      line: null,
      originalLine: 29,
      originalStartLine: 27,
      createdAt: "2026-08-02T12:36:35Z",
      body: "_🎯 Functional Correctness_ | _🟡 Minor_\n\n**This link points at a moved anchor.**\n\nThe section it references was renamed earlier in this document.",
    }),
  ]),
  thread("PRRT_2924_codex", true, true, [
    comment({
      databaseId: 6003,
      login: "chatgpt-codex-connector",
      path: "docs/qa/keiko-for-quality.md",
      line: null,
      originalLine: 33,
      originalStartLine: 31,
      createdAt: "2026-08-02T11:07:25Z",
      body: "_P2_\n\n**The example endpoint is not a real placeholder domain.**\n\nUse a reserved example domain so nobody mistakes this for a live endpoint.",
    }),
  ]),
];
