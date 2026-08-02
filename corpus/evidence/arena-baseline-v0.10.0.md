# Reviewer arena scoreboard

Generated 2026-08-02T16:12:23.681Z for `oscharko-dev/Keiko`.

## Identity

Every login this run observed, and which arena bot (if any) it resolved to — so a bot that migrates identity, or an unrecognized login, is visible here rather than silently miscounted.

| Observed login            | Account type | Resolved to       | Comments | Flag |
| ------------------------- | ------------ | ----------------- | -------- | ---- |
| `chatgpt-codex-connector` | Bot          | Codex             | 22       |      |
| `coderabbitai`            | Bot          | CodeRabbit        | 53       |      |
| `keiko-for-quality`       | Bot          | Keiko for Quality | 64       |      |
| `oscharko`                | User         | (unattributed)    | 20       |      |

## Heuristics

- **Duplicate similarity** (`jaccard-token-set-v1`, threshold 0.15): Two of one bot's own findings on the same pull request are treated as duplicate variants of one finding when they share a path, their line windows overlap, and the Jaccard similarity of their normalized content-word sets is at least the threshold. Estimates, not a correctness judgement — see corpus/arena-lib.mjs for the exact normalization.
- **Cross-bot overlap** (`path-and-line-window-intersection-v1`): A cross-bot overlap cluster groups distinct (already deduplicated) findings from different bots that share a path and an overlapping line window. No content comparison is applied across bots, so this is a proxy for consensus location, not for agreement on the claim.
- **Incomplete notice** (`literal-phrase-match-v1`): A conversation is an incomplete-review notice, not a finding, when its body contains the fixed sentence Keiko for Quality's publisher emits for a settlement notice. Calibrated on this reviewer; other bots are checked against the same phrase for symmetry but are not expected to match it.

> Duplicate-variant and cross-bot-overlap counts are heuristic estimates for a repeatable scoreboard, not a human adjudication of correctness or noise. See the pull request that introduced this tool for calibration evidence.

## Per pull request

### Pull request #2924 (head `da36cc152f1b`)

| Bot               | Posted | Distinct | Duplicates | Notices | Files | Resolved | Unresolved | Outdated | Unique | vs Keiko for Quality | vs CodeRabbit | vs Codex | All three |
| ----------------- | ------ | -------- | ---------- | ------- | ----- | -------- | ---------- | -------- | ------ | -------------------- | ------------- | -------- | --------- |
| Keiko for Quality | 0      | 0        | 0          | 1       | 1     | 1        | 0          | 0        | 0      | —                    | 0             | 0        | 0         |
| CodeRabbit        | 1      | 1        | 0          | 0       | 1     | 1        | 0          | 0        | 1      | 0                    | —             | 0        | 0         |
| Codex             | 1      | 1        | 0          | 0       | 1     | 1        | 0          | 0        | 1      | 0                    | 0             | —        | 0         |

Duplicate-variant clusters: none.

Cross-bot overlap clusters: none.

### Pull request #2926 (head `c827cdb38056`)

| Bot               | Posted | Distinct | Duplicates | Notices | Files | Resolved | Unresolved | Outdated | Unique | vs Keiko for Quality | vs CodeRabbit | vs Codex | All three |
| ----------------- | ------ | -------- | ---------- | ------- | ----- | -------- | ---------- | -------- | ------ | -------------------- | ------------- | -------- | --------- |
| Keiko for Quality | 59     | 44       | 15         | 4       | 35    | 14       | 36         | 13       | 31     | —                    | 9             | 8        | 4         |
| CodeRabbit        | 52     | 52       | 0          | 0       | 36    | 33       | 18         | 1        | 40     | 9                    | —             | 7        | 4         |
| Codex             | 21     | 21       | 0          | 0       | 18    | 3        | 8          | 10       | 10     | 8                    | 7             | —        | 4         |

Duplicate-variant clusters:

- packages/keiko-contracts/src/voice-session-recap.ts — Keiko for Quality, 2 variants
- packages/keiko-server/src/coding-context/codingContextRoutes.ts:235-236 — Keiko for Quality, 3 variants
- packages/keiko-server/src/deps.ts:3584-3585 — Keiko for Quality, 2 variants
- packages/keiko-server/src/gateway-setup.test.ts — Keiko for Quality, 2 variants
- packages/keiko-server/src/grounded-orchestrator.ts:3216-3217 — Keiko for Quality, 2 variants
- packages/keiko-server/src/memory-capture-policy.ts:207-212 — Keiko for Quality, 2 variants
- packages/keiko-server/src/memory-maintenance-handlers.ts:575-599 — Keiko for Quality, 3 variants
- packages/keiko-server/src/runtime/containerRunner.ts:382-387 — Keiko for Quality, 2 variants
- packages/keiko-server/src/update-remediation.ts:331-338 — Keiko for Quality, 3 variants
- packages/keiko-server/src/update-session-lock.ts:250-262 — Keiko for Quality, 2 variants
- packages/keiko-ui/src/app/components/desktop/modals/GatewaySetupDialog.tsx:2040-2044 — Keiko for Quality, 3 variants

Cross-bot overlap clusters:

- packages/keiko-contracts/src/bff-wire.ts:1547-1548 — Keiko for Quality + CodeRabbit + Codex
- packages/keiko-contracts/src/voice-session-recap.ts — Keiko for Quality + CodeRabbit + Codex
- packages/keiko-memory-vault/src/tombstones.ts:51-52 — CodeRabbit + Codex
- packages/keiko-memory-vault/src/vault.ts:628-641 — Keiko for Quality + CodeRabbit
- packages/keiko-server/src/coding-context/codingContextRoutes.ts:235-243 — Keiko for Quality + CodeRabbit
- packages/keiko-server/src/coding-sidecar-gateway.test.ts:521-543 — Keiko for Quality + CodeRabbit
- packages/keiko-server/src/deps.ts:3584-3585 — Keiko for Quality + Codex
- packages/keiko-server/src/gateway-instance-cache.ts — Keiko for Quality + CodeRabbit + Codex
- packages/keiko-server/src/gateway-setup.test.ts — Keiko for Quality + CodeRabbit
- packages/keiko-server/src/gateway-setup.ts:350-360 — CodeRabbit + Codex
- packages/keiko-server/src/memory-conv-handlers.ts:495-500 — Keiko for Quality + CodeRabbit + Codex
- packages/keiko-server/src/memory-handlers.ts:638-644 — CodeRabbit + Codex
- packages/keiko-server/src/memory-maintenance-handlers.ts:575-593 — Keiko for Quality + Codex
- packages/keiko-server/src/run-engine.ts:425-426 — Keiko for Quality + CodeRabbit
- packages/keiko-server/src/runtime/containerRunner.ts:385-386 — Keiko for Quality + Codex
- packages/keiko-server/src/update-remediation.ts:331-338 — Keiko for Quality + Codex

## Aggregate across 2 pull request(s)

| Bot               | Posted | Distinct | Duplicates | Notices | Files | Resolved | Unresolved | Outdated | Unique | vs Keiko for Quality | vs CodeRabbit | vs Codex | All three |
| ----------------- | ------ | -------- | ---------- | ------- | ----- | -------- | ---------- | -------- | ------ | -------------------- | ------------- | -------- | --------- |
| Keiko for Quality | 59     | 44       | 15         | 5       | 36    | 15       | 36         | 13       | 31     | —                    | 9             | 8        | 4         |
| CodeRabbit        | 53     | 53       | 0          | 0       | 37    | 34       | 18         | 1        | 41     | 9                    | —             | 7        | 4         |
| Codex             | 22     | 22       | 0          | 0       | 19    | 4        | 8          | 10       | 11     | 8                    | 7             | —        | 4         |
