# Reviewer arena scoreboard

Generated 2026-08-02T22:30:00.000Z for `oscharko-dev/Keiko`.

## Identity

Every login this run observed, and which arena bot (if any) it resolved to — so a bot that migrates identity, or an unrecognized login, is visible here rather than silently miscounted.

| Observed login            | Account type | Resolved to       | Comments | Flag |
| ------------------------- | ------------ | ----------------- | -------- | ---- |
| `chatgpt-codex-connector` | Bot          | Codex             | 46       |      |
| `coderabbitai`            | Bot          | CodeRabbit        | 53       |      |
| `keiko-for-quality`       | Bot          | Keiko for Quality | 131      |      |
| `oscharko`                | User         | (unattributed)    | 113      |      |

## Heuristics

- **Duplicate similarity** (`jaccard-token-set-v1`, threshold 0.15): Two of one bot's own findings on the same pull request are treated as duplicate variants of one finding when they share a path, their line windows overlap, and the Jaccard similarity of their normalized content-word sets is at least the threshold. Estimates, not a correctness judgement — see corpus/arena-lib.mjs for the exact normalization.
- **Cross-bot overlap** (`path-and-line-window-intersection-v1`): A cross-bot overlap cluster groups distinct (already deduplicated) findings from different bots that share a path and an overlapping line window. No content comparison is applied across bots, so this is a proxy for consensus location, not for agreement on the claim.
- **Incomplete notice** (`literal-phrase-match-v1`): A conversation is an incomplete-review notice, not a finding, when its body contains the fixed sentence Keiko for Quality's publisher emits for a settlement notice. Calibrated on this reviewer; other bots are checked against the same phrase for symmetry but are not expected to match it.
- **Acted-upon linking** (`later-commit-hunk-overlap-v1`, ±3 lines): A finding is acted_upon when a commit pushed to the pull request after the finding was posted changes its anchored region: the same file, within the line tolerance, found by parsing that commit's own unified-diff hunk headers — thread-resolved status plays no part in this check. A finding with no later commit at all had no opportunity to be acted upon and is excluded from the opportunity-adjusted rate. A same-file, same-line-window proxy misses a fix landing in a different file for the same root cause, and checks each later commit against the finding's original anchor independently rather than tracking a line's drift through a chain of commits — see corpus/arena-lib.mjs and the pull request that introduced this heuristic for a worked comparison against a hand-verified pass.

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

#### Acted-upon linking (last push 2026-08-02T12:39:18Z, ±3 line tolerance)

| Bot               | Distinct | Had opportunity | Acted upon | Resolved w/o change | Open unaddressed | Outdated/unmappable | Rate (raw) | Rate (adjusted) |
| ----------------- | -------- | --------------- | ---------- | ------------------- | ---------------- | ------------------- | ---------- | --------------- |
| Keiko for Quality | 0        | 0               | 0          | 0                   | 0                | 0                   | n/a        | n/a             |
| CodeRabbit        | 1        | 1               | 1          | 0                   | 0                | 0                   | 100%       | 100%            |
| Codex             | 1        | 1               | 1          | 0                   | 0                | 0                   | 100%       | 100%            |

**CodeRabbit:**

- docs/qa/keiko-for-quality.md:27-29 — acted_upon (commit `da36cc152f1b`)

**Codex:**

- docs/qa/keiko-for-quality.md:31-33 — acted_upon (commit `35fb2e9a6ed9`)

### Pull request #2926 (head `19672bfa0ad0`)

| Bot               | Posted | Distinct | Duplicates | Notices | Files | Resolved | Unresolved | Outdated | Unique | vs Keiko for Quality | vs CodeRabbit | vs Codex | All three |
| ----------------- | ------ | -------- | ---------- | ------- | ----- | -------- | ---------- | -------- | ------ | -------------------- | ------------- | -------- | --------- |
| Keiko for Quality | 66     | 49       | 17         | 4       | 37    | 59       | 11         | 0        | 35     | —                    | 9             | 9        | 4         |
| CodeRabbit        | 52     | 52       | 0          | 0       | 36    | 52       | 0          | 0        | 40     | 9                    | —             | 7        | 4         |
| Codex             | 25     | 25       | 0          | 0       | 19    | 21       | 4          | 0        | 13     | 9                    | 7             | —        | 4         |

Duplicate-variant clusters:

- packages/keiko-contracts/src/voice-session-recap.ts — Keiko for Quality, 1 finding + 1 duplicate variant(s)
- packages/keiko-memory-vault/src/vault.ts:634-641 — Keiko for Quality, 1 finding + 1 duplicate variant(s)
- packages/keiko-server/src/coding-context/codingContextRoutes.ts:235-236 — Keiko for Quality, 1 finding + 2 duplicate variant(s)
- packages/keiko-server/src/deps.ts:3584-3585 — Keiko for Quality, 1 finding + 1 duplicate variant(s)
- packages/keiko-server/src/gateway-setup.test.ts — Keiko for Quality, 1 finding + 1 duplicate variant(s)
- packages/keiko-server/src/grounded-orchestrator.ts:3216-3217 — Keiko for Quality, 1 finding + 1 duplicate variant(s)
- packages/keiko-server/src/memory-capture-policy.ts:207-212 — Keiko for Quality, 1 finding + 1 duplicate variant(s)
- packages/keiko-server/src/memory-maintenance-handlers.ts:575-601 — Keiko for Quality, 1 finding + 3 duplicate variant(s)
- packages/keiko-server/src/runtime/containerRunner.ts:382-387 — Keiko for Quality, 1 finding + 1 duplicate variant(s)
- packages/keiko-server/src/update-remediation.ts:331-338 — Keiko for Quality, 1 finding + 2 duplicate variant(s)
- packages/keiko-server/src/update-session-lock.ts:250-262 — Keiko for Quality, 1 finding + 1 duplicate variant(s)
- packages/keiko-ui/src/app/components/desktop/modals/GatewaySetupDialog.tsx:2040-2044 — Keiko for Quality, 1 finding + 2 duplicate variant(s)

Cross-bot overlap clusters:

- packages/keiko-contracts/src/bff-wire.ts:1547-1548 — Keiko for Quality + CodeRabbit + Codex
- packages/keiko-contracts/src/voice-session-recap.ts — Keiko for Quality + CodeRabbit + Codex
- packages/keiko-memory-vault/src/tombstones.ts:51-52 — CodeRabbit + Codex
- packages/keiko-memory-vault/src/vault.ts:628-641 — Keiko for Quality + CodeRabbit
- packages/keiko-server/src/coding-context/codingContextRoutes.ts:235-243 — Keiko for Quality + CodeRabbit
- packages/keiko-server/src/coding-sidecar-gateway.test.ts:521-543 — Keiko for Quality + CodeRabbit
- packages/keiko-server/src/deps.ts:1054-1062 — Keiko for Quality + Codex
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

#### Acted-upon linking (last push 2026-08-02T16:53:33Z, ±3 line tolerance)

| Bot               | Distinct | Had opportunity | Acted upon | Resolved w/o change | Open unaddressed | Outdated/unmappable | Rate (raw) | Rate (adjusted) |
| ----------------- | -------- | --------------- | ---------- | ------------------- | ---------------- | ------------------- | ---------- | --------------- |
| Keiko for Quality | 49       | 44              | 32         | 12                  | 5                | 0                   | 65%        | 73%             |
| CodeRabbit        | 52       | 52              | 48         | 4                   | 0                | 0                   | 92%        | 92%             |
| Codex             | 25       | 21              | 18         | 3                   | 4                | 0                   | 72%        | 86%             |

**Keiko for Quality:**

- packages/keiko-contracts/src/bff-wire.ts:1548 — resolved_without_change
- packages/keiko-contracts/src/voice-session-recap.test.ts:64-67 — resolved_without_change
- packages/keiko-contracts/src/voice-session-recap.ts — resolved_without_change
- packages/keiko-memory-vault/src/tombstones.test.ts:142-153 — acted_upon (commit `c827cdb38056`)
- packages/keiko-memory-vault/src/tombstones.ts:255-263 — acted_upon (commit `c827cdb38056`)
- packages/keiko-memory-vault/src/tombstones.ts:301-310 — acted_upon (commit `c827cdb38056`)
- packages/keiko-memory-vault/src/types.ts — acted_upon (commit `c827cdb38056`)
- packages/keiko-memory-vault/src/vault.ts:636-641 — resolved_without_change
- packages/keiko-server/src/coding-context/codingContextRoutes.ts:235-236 — acted_upon (commit `3ad49d305138`)
- packages/keiko-server/src/coding-sidecar-gateway.test.ts:522-524 — acted_upon (commit `19672bfa0ad0`)
- packages/keiko-server/src/coding-sidecar-gateway.ts:176-177 — resolved_without_change
- packages/keiko-server/src/deps.test.ts:1026-1031 — acted_upon (commit `3ad49d305138`)
- packages/keiko-server/src/deps.ts:1054-1057 — acted_upon (commit `3ad49d305138`)
- packages/keiko-server/src/deps.ts:3584-3585 — acted_upon (commit `3ad49d305138`)
- packages/keiko-server/src/editor/localHistory/localHistoryCapture.ts:89-93 — resolved_without_change
- packages/keiko-server/src/gateway-instance-cache.ts — acted_upon (commit `19672bfa0ad0`)
- packages/keiko-server/src/gateway-instance-cache.ts:46-48 — open_unaddressed, no push followed it
- packages/keiko-server/src/gateway-setup.test.ts — acted_upon (commit `c9b97f4c4db8`)
- packages/keiko-server/src/gateway-setup.ts:582-583 — acted_upon (commit `3ad49d305138`)
- packages/keiko-server/src/gateway-setup.ts:2814 — resolved_without_change
- packages/keiko-server/src/gateway-setup.ts:3546-3560 — acted_upon (commit `3ad49d305138`)
- packages/keiko-server/src/gateway-setup.ts:3617-3631 — resolved_without_change
- packages/keiko-server/src/grounded-orchestrator.ts:3216-3217 — acted_upon (commit `3ad49d305138`)
- packages/keiko-server/src/grounded-qa-hybrid.test.ts:1339-1344 — acted_upon (commit `3ad49d305138`)
- packages/keiko-server/src/grounded-qa-multi-source.ts:1048-1057 — acted_upon (commit `19672bfa0ad0`)
- packages/keiko-server/src/grounded-qa.ts:1275-1282 — acted_upon (commit `3ad49d305138`)
- packages/keiko-server/src/memory-capture-policy.ts:207-212 — resolved_without_change
- packages/keiko-server/src/memory-conv-handlers.test.ts:577-582 — open_unaddressed, no push followed it
- packages/keiko-server/src/memory-conv-handlers.ts:495-498 — acted_upon (commit `3ad49d305138`)
- packages/keiko-server/src/memory-maintenance-handlers.ts:575-593 — acted_upon (commit `3ad49d305138`)
- packages/keiko-server/src/routes.ts:453-457 — resolved_without_change
- packages/keiko-server/src/routes.ts:1183 — resolved_without_change
- packages/keiko-server/src/run-engine.ts:425-426 — acted_upon (commit `3ad49d305138`)
- packages/keiko-server/src/runtime/containerRunner.ts:385-386 — acted_upon (commit `3ad49d305138`)
- packages/keiko-server/src/store-handlers.ts:421-428 — acted_upon (commit `19672bfa0ad0`)
- packages/keiko-server/src/update-local-state.ts:286-293 — open_unaddressed, no push followed it
- packages/keiko-server/src/update-remediation.ts:331-338 — acted_upon (commit `3ad49d305138`)
- packages/keiko-server/src/update-remediation.ts:382-391 — acted_upon (commit `19672bfa0ad0`)
- packages/keiko-server/src/update-session-lock.ts:177 — acted_upon (commit `3ad49d305138`)
- packages/keiko-server/src/update-session-lock.ts:250-260 — acted_upon (commit `c827cdb38056`)
- packages/keiko-server/src/update-session-lock.ts:310-320 — acted_upon (commit `19672bfa0ad0`)
- packages/keiko-server/src/update-session-lock.ts:357-367 — open_unaddressed, no push followed it
- packages/keiko-server/src/update-session.ts:508-512 — acted_upon (commit `19672bfa0ad0`)
- packages/keiko-server/src/voice-handlers.ts:427-432 — acted_upon (commit `c827cdb38056`)
- packages/keiko-ui/src/app/components/desktop/modals/GatewaySetupDialog.tsx:2040-2044 — resolved_without_change
- packages/keiko-ui/src/app/components/desktop/widgets/panels/SettingsPanel.tsx:397-404 — acted_upon (commit `3ad49d305138`)
- packages/keiko-ui/src/app/components/desktop/widgets/panels/SettingsPanel.tsx:1624-1629 — acted_upon (commit `3ad49d305138`)
- packages/keiko-ui/src/app/components/desktop/widgets/panels/SettingsPanel.tsx:1694-1702 — open_unaddressed, no push followed it
- packages/keiko-ui/src/app/components/desktop/widgets/panels/SettingsPanel.tsx:1697-1700 — acted_upon (commit `19672bfa0ad0`)

**CodeRabbit:**

- docs/adr/ADR-0109-voice-session-recap.md:16-25 — acted_upon (commit `3ad49d305138`)
- docs/adr/ADR-0109-voice-session-recap.md:310-322 — acted_upon (commit `19672bfa0ad0`)
- docs/adr/ADR-0171-gateway-readiness-capability-reconciliation.md:48-51 — acted_upon (commit `3ad49d305138`)
- docs/adr/ADR-0171-gateway-readiness-capability-reconciliation.md:54-60 — acted_upon (commit `19672bfa0ad0`)
- packages/keiko-contracts/src/bff-wire.ts:1547-1548 — resolved_without_change
- packages/keiko-contracts/src/voice-session-recap.ts:98 — resolved_without_change
- packages/keiko-memory-vault/src/tombstones.ts:51-52 — acted_upon (commit `c9b97f4c4db8`)
- packages/keiko-memory-vault/src/tombstones.ts:185-252 — acted_upon (commit `3ad49d305138`)
- packages/keiko-memory-vault/src/tombstones.ts:266-291 — acted_upon (commit `3ad49d305138`)
- packages/keiko-memory-vault/src/vault.ts:628-638 — acted_upon (commit `3ad49d305138`)
- packages/keiko-memory-vault/src/vault.ts:723-725 — acted_upon (commit `c9b97f4c4db8`)
- packages/keiko-server/src/coding-context/codingContextRoutes.test.ts:140-162 — acted_upon (commit `19672bfa0ad0`)
- packages/keiko-server/src/coding-context/codingContextRoutes.ts:235-243 — acted_upon (commit `3ad49d305138`)
- packages/keiko-server/src/coding-context/codingContextRoutes.ts:241-249 — acted_upon (commit `19672bfa0ad0`)
- packages/keiko-server/src/coding-sidecar-gateway.test.ts:521-543 — acted_upon (commit `3ad49d305138`)
- packages/keiko-server/src/deps.test.ts:1052-1076 — acted_upon (commit `19672bfa0ad0`)
- packages/keiko-server/src/deps.ts:355-356 — acted_upon (commit `19672bfa0ad0`)
- packages/keiko-server/src/gateway-instance-cache.test.ts:26-41 — acted_upon (commit `19672bfa0ad0`)
- packages/keiko-server/src/gateway-instance-cache.ts:34-36 — acted_upon (commit `3ad49d305138`)
- packages/keiko-server/src/gateway-setup.test.ts:311-360 — acted_upon (commit `3ad49d305138`)
- packages/keiko-server/src/gateway-setup.ts:344-348 — acted_upon (commit `3ad49d305138`)
- packages/keiko-server/src/gateway-setup.ts:350-360 — acted_upon (commit `c9b97f4c4db8`)
- packages/keiko-server/src/gateway-setup.ts:561-572 — acted_upon (commit `3ad49d305138`)
- packages/keiko-server/src/grounded-qa-hybrid.ts:1008-1009 — acted_upon (commit `3ad49d305138`)
- packages/keiko-server/src/memory-capture-autonomy.test.ts:363-368 — acted_upon (commit `3ad49d305138`)
- packages/keiko-server/src/memory-conv-handlers.ts:495-500 — acted_upon (commit `3ad49d305138`)
- packages/keiko-server/src/memory-handlers.test.ts:226-265 — acted_upon (commit `3ad49d305138`)
- packages/keiko-server/src/memory-handlers.ts:638-640 — acted_upon (commit `c9b97f4c4db8`)
- packages/keiko-server/src/memory-maintenance-handlers.test.ts:252-260 — acted_upon (commit `3ad49d305138`)
- packages/keiko-server/src/memory-maintenance-handlers.test.ts:270-285 — acted_upon (commit `3ad49d305138`)
- packages/keiko-server/src/relationship-handlers.test.ts:178-185 — resolved_without_change
- packages/keiko-server/src/relationship-handlers.test.ts:287-320 — acted_upon (commit `3ad49d305138`)
- packages/keiko-server/src/relationship-handlers.test.ts:322-395 — resolved_without_change
- packages/keiko-server/src/run-engine.test.ts:139 — acted_upon (commit `3ad49d305138`)
- packages/keiko-server/src/run-engine.test.ts:142-145 — acted_upon (commit `3ad49d305138`)
- packages/keiko-server/src/run-engine.ts:425-426 — acted_upon (commit `3ad49d305138`)
- packages/keiko-server/src/store-handlers.test.ts:364-371 — acted_upon (commit `19672bfa0ad0`)
- packages/keiko-server/src/update-remediation.test.ts:398-438 — acted_upon (commit `3ad49d305138`)
- packages/keiko-server/src/update-remediation.ts:347-361 — acted_upon (commit `3ad49d305138`)
- packages/keiko-server/src/voice-action-governance.test.ts:463-477 — acted_upon (commit `19672bfa0ad0`)
- packages/keiko-server/src/voice-handlers.test.ts:260-285 — acted_upon (commit `c827cdb38056`)
- packages/keiko-server/src/voice-recap.test.ts:251-261 — acted_upon (commit `3ad49d305138`)
- packages/keiko-server/src/workspace-root-identity.test.ts:44-47 — acted_upon (commit `3ad49d305138`)
- packages/keiko-tools/src/exec.test.ts:130-151 — acted_upon (commit `c9b97f4c4db8`)
- packages/keiko-tools/src/exec.test.ts:152-171 — acted_upon (commit `19672bfa0ad0`)
- packages/keiko-ui/src/app/components/desktop/widgets/cards/EditorRuntimeWidget.tsx:6593-6595 — acted_upon (commit `3ad49d305138`)
- packages/keiko-ui/src/app/components/desktop/widgets/panels/SettingsPanel.test.tsx:685-704 — acted_upon (commit `3ad49d305138`)
- packages/keiko-ui/src/app/components/desktop/widgets/panels/SettingsPanel.tsx:436-447 — acted_upon (commit `19672bfa0ad0`)
- packages/keiko-ui/src/app/components/desktop/widgets/panels/SettingsPanel.tsx:436-451 — acted_upon (commit `3ad49d305138`)
- packages/keiko-ui/src/app/components/desktop/widgets/panels/SettingsPanel.tsx:444-451 — acted_upon (commit `3ad49d305138`)
- packages/keiko-ui/src/lib/api.ts:404-406 — acted_upon (commit `19672bfa0ad0`)
- packages/keiko-ui/src/lib/api.ts:675-687 — acted_upon (commit `3ad49d305138`)

**Codex:**

- packages/keiko-contracts/src/bff-wire.ts:1547-1548 — resolved_without_change
- packages/keiko-contracts/src/voice-session-recap.ts:143 — acted_upon (commit `3ad49d305138`)
- packages/keiko-memory-vault/src/tombstones.ts:51-52 — acted_upon (commit `c9b97f4c4db8`)
- packages/keiko-server/src/chat-handlers.ts:1044-1050 — open_unaddressed, no push followed it
- packages/keiko-server/src/chat-handlers.ts:1268-1271 — resolved_without_change
- packages/keiko-server/src/chat-handlers.ts:1281-1287 — open_unaddressed, no push followed it
- packages/keiko-server/src/deps.ts:1057-1062 — open_unaddressed, no push followed it
- packages/keiko-server/src/deps.ts:3584-3585 — acted_upon (commit `3ad49d305138`)
- packages/keiko-server/src/gateway-instance-cache.ts:34-36 — acted_upon (commit `3ad49d305138`)
- packages/keiko-server/src/gateway-readiness.ts:1129 — acted_upon (commit `3ad49d305138`)
- packages/keiko-server/src/gateway-setup.ts:350-354 — acted_upon (commit `c9b97f4c4db8`)
- packages/keiko-server/src/gateway-setup.ts:3600 — acted_upon (commit `19672bfa0ad0`)
- packages/keiko-server/src/memory-conv-handlers.ts:495-500 — acted_upon (commit `3ad49d305138`)
- packages/keiko-server/src/memory-handlers.ts:167-168 — resolved_without_change
- packages/keiko-server/src/memory-handlers.ts:638-644 — acted_upon (commit `c9b97f4c4db8`)
- packages/keiko-server/src/memory-maintenance-handlers.ts:580-591 — acted_upon (commit `3ad49d305138`)
- packages/keiko-server/src/runtime/containerRunner.ts:385 — acted_upon (commit `3ad49d305138`)
- packages/keiko-server/src/store-handlers.ts:409-413 — acted_upon (commit `3ad49d305138`)
- packages/keiko-server/src/update-local-state.ts:297-300 — open_unaddressed, no push followed it
- packages/keiko-server/src/update-remediation.ts:331-338 — acted_upon (commit `3ad49d305138`)
- packages/keiko-server/src/update-session-lock.ts:171-172 — acted_upon (commit `3ad49d305138`)
- packages/keiko-server/src/voice-recap.ts:274-276 — acted_upon (commit `c9b97f4c4db8`)
- packages/keiko-server/src/voice-recap.ts:329 — acted_upon (commit `19672bfa0ad0`)
- packages/keiko-tools/src/exec.ts:595-599 — acted_upon (commit `c9b97f4c4db8`)
- packages/keiko-ui/src/app/components/desktop/modals/GatewaySetupDialog.tsx:555-557 — acted_upon (commit `c9b97f4c4db8`)

### Pull request #2930 (head `af705c164551`)

| Bot               | Posted | Distinct | Duplicates | Notices | Files | Resolved | Unresolved | Outdated | Unique | vs Keiko for Quality | vs CodeRabbit | vs Codex | All three |
| ----------------- | ------ | -------- | ---------- | ------- | ----- | -------- | ---------- | -------- | ------ | -------------------- | ------------- | -------- | --------- |
| Keiko for Quality | 58     | 46       | 12         | 2       | 31    | 6        | 38         | 16       | 41     | —                    | 0             | 4        | 0         |
| CodeRabbit        | 0      | 0        | 0          | 0       | 0     | 0        | 0          | 0        | 0      | 0                    | —             | 0        | 0         |
| Codex             | 20     | 20       | 0          | 0       | 15    | 5        | 7          | 8        | 15     | 4                    | 0             | —        | 0         |

Duplicate-variant clusters:

- packages/keiko-memory-vault/src/tombstones.ts:329-334 — Keiko for Quality, 1 finding + 1 duplicate variant(s)
- packages/keiko-server/src/grounded-qa-hybrid.ts — Keiko for Quality, 1 finding + 1 duplicate variant(s)
- packages/keiko-server/src/update-local-state.ts:286-293 — Keiko for Quality, 1 finding + 1 duplicate variant(s)
- packages/keiko-server/src/update-local-state.ts:331-343 — Keiko for Quality, 1 finding + 2 duplicate variant(s)
- packages/keiko-server/src/update-session-lock.ts:236-245 — Keiko for Quality, 1 finding + 3 duplicate variant(s)
- packages/keiko-ui/src/app/components/desktop/hooks/useChatSession.ts:2528-2538 — Keiko for Quality, 1 finding + 1 duplicate variant(s)
- packages/keiko-ui/src/app/components/desktop/modals/GatewaySetupDialog.tsx:2040-2044 — Keiko for Quality, 1 finding + 1 duplicate variant(s)
- packages/keiko-ui/src/app/components/desktop/widgets/panels/SettingsPanel.tsx:1703-1713 — Keiko for Quality, 1 finding + 2 duplicate variant(s)

Cross-bot overlap clusters:

- packages/keiko-server/src/editor/completionRoutes.ts:103-105 — Keiko for Quality + Codex
- packages/keiko-server/src/gateway-setup.ts:3399-3410 — Keiko for Quality + Codex
- packages/keiko-server/src/update-session-lock.ts:240-245 — Keiko for Quality + Codex
- packages/keiko-ui/src/app/components/desktop/widgets/panels/SettingsPanel.tsx:1694-1702 — Keiko for Quality + Codex

#### Acted-upon linking (last push 2026-08-02T19:58:53Z, ±3 line tolerance)

| Bot               | Distinct | Had opportunity | Acted upon | Resolved w/o change | Open unaddressed | Outdated/unmappable | Rate (raw) | Rate (adjusted) |
| ----------------- | -------- | --------------- | ---------- | ------------------- | ---------------- | ------------------- | ---------- | --------------- |
| Keiko for Quality | 46       | 41              | 32         | 1                   | 13               | 0                   | 70%        | 78%             |
| CodeRabbit        | 0        | 0               | 0          | 0                   | 0                | 0                   | n/a        | n/a             |
| Codex             | 20       | 20              | 13         | 1                   | 6                | 0                   | 65%        | 65%             |

**Keiko for Quality:**

- packages/keiko-memory-vault/src/tombstones.test.ts:56-60 — acted_upon (commit `af705c164551`)
- packages/keiko-memory-vault/src/tombstones.test.ts:169-172 — acted_upon (commit `af705c164551`)
- packages/keiko-memory-vault/src/tombstones.ts:329-334 — open_unaddressed
- packages/keiko-memory-vault/src/vault.ts — open_unaddressed
- packages/keiko-memory-vault/src/vault.ts:634 — open_unaddressed
- packages/keiko-server/src/chat-handlers.ts:1298-1305 — open_unaddressed, no push followed it
- packages/keiko-server/src/coding-context/codingContextRoutes.ts:281 — acted_upon (commit `60ae0e3e26b4`)
- packages/keiko-server/src/editor/completionRoutes.ts:103-105 — acted_upon (commit `d14864ca15f1`)
- packages/keiko-server/src/gateway-instance-cache.test.ts:58-64 — acted_upon (commit `60ae0e3e26b4`)
- packages/keiko-server/src/gateway-instance-cache.ts:46-48 — acted_upon (commit `d14864ca15f1`)
- packages/keiko-server/src/gateway-readiness.test.ts:805-812 — open_unaddressed, no push followed it
- packages/keiko-server/src/gateway-readiness.ts:1119-1130 — open_unaddressed
- packages/keiko-server/src/gateway-readiness.ts:1178-1183 — acted_upon (commit `5cfcae3c1610`)
- packages/keiko-server/src/gateway-setup.test.ts:339-350 — open_unaddressed, no push followed it
- packages/keiko-server/src/gateway-setup.ts:2866 — resolved_without_change
- packages/keiko-server/src/gateway-setup.ts:3370-3372 — open_unaddressed
- packages/keiko-server/src/gateway-setup.ts:3402-3410 — acted_upon (commit `af705c164551`)
- packages/keiko-server/src/grounded-qa-hybrid.ts:1008-1011 — acted_upon (commit `5cfcae3c1610`)
- packages/keiko-server/src/grounded-qa-multi-source.ts:1060-1068 — acted_upon (commit `af705c164551`)
- packages/keiko-server/src/memory-capture-policy.ts:207-212 — acted_upon (commit `af705c164551`)
- packages/keiko-server/src/memory-capture-policy.ts:213-218 — acted_upon (commit `af705c164551`)
- packages/keiko-server/src/memory-conv-handlers.test.ts:606-609 — acted_upon (commit `af2a252ab9f9`)
- packages/keiko-server/src/memory-conv-handlers.ts:499-502 — acted_upon (commit `af2a252ab9f9`)
- packages/keiko-server/src/memory-handlers.ts:693-697 — acted_upon (commit `af705c164551`)
- packages/keiko-server/src/memory-maintenance-handlers.ts:458-468 — acted_upon (commit `60ae0e3e26b4`)
- packages/keiko-server/src/memory-maintenance-handlers.ts:465-467 — acted_upon (commit `60ae0e3e26b4`)
- packages/keiko-server/src/memory-maintenance-handlers.ts:594-601 — open_unaddressed
- packages/keiko-server/src/runtime/containerRunner.ts:376-381 — acted_upon (commit `af705c164551`)
- packages/keiko-server/src/update-local-state.ts:286-293 — acted_upon (commit `86a3e1af07e3`)
- packages/keiko-server/src/update-local-state.ts:295-302 — acted_upon (commit `86a3e1af07e3`)
- packages/keiko-server/src/update-local-state.ts:331-339 — acted_upon (commit `60ae0e3e26b4`)
- packages/keiko-server/src/update-local-state.ts:332-343 — acted_upon (commit `af705c164551`)
- packages/keiko-server/src/update-remediation.ts:299-306 — acted_upon (commit `af2a252ab9f9`)
- packages/keiko-server/src/update-remediation.ts:399-411 — open_unaddressed, no push followed it
- packages/keiko-server/src/update-session-lock.ts:240-244 — acted_upon (commit `d14864ca15f1`)
- packages/keiko-server/src/update-session-lock.ts:360-361 — acted_upon (commit `af705c164551`)
- packages/keiko-server/src/update-session.test.ts:592-593 — acted_upon (commit `60ae0e3e26b4`)
- packages/keiko-server/src/update-session.test.ts:642 — open_unaddressed
- packages/keiko-server/src/voice-recap.test.ts:266-268 — acted_upon (commit `d14864ca15f1`)
- packages/keiko-ui/src/app/components/desktop/hooks/useChatSession.ts:2528-2535 — acted_upon (commit `af705c164551`)
- packages/keiko-ui/src/app/components/desktop/modals/GatewaySetupDialog.tsx:2040-2044 — open_unaddressed
- packages/keiko-ui/src/app/components/desktop/widgets/panels/SettingsPanel.test.tsx:696-699 — acted_upon (commit `5cfcae3c1610`)
- packages/keiko-ui/src/app/components/desktop/widgets/panels/SettingsPanel.tsx:1694-1702 — acted_upon (commit `5cfcae3c1610`)
- packages/keiko-ui/src/app/components/desktop/widgets/panels/SettingsPanel.tsx:1694-1702 — acted_upon (commit `5cfcae3c1610`)
- packages/keiko-ui/src/app/components/desktop/widgets/panels/SettingsPanel.tsx:1703-1712 — acted_upon (commit `60ae0e3e26b4`)
- packages/keiko-ui/src/lib/api.boundaries.test.ts:102-104 — open_unaddressed, no push followed it

**Codex:**

- packages/keiko-contracts/src/voice-session-recap.ts:103 — acted_upon (commit `60ae0e3e26b4`)
- packages/keiko-contracts/src/voice-session-recap.ts:117 — acted_upon (commit `86a3e1af07e3`)
- packages/keiko-memory-vault/src/tombstones.ts:246-247 — open_unaddressed
- packages/keiko-server/src/chat-handlers.ts:1045-1046 — acted_upon (commit `86a3e1af07e3`)
- packages/keiko-server/src/chat-handlers.ts:1276-1279 — acted_upon (commit `af2a252ab9f9`)
- packages/keiko-server/src/coding-sidecar-gateway.ts:177-179 — open_unaddressed
- packages/keiko-server/src/deps.ts:3608 — acted_upon (commit `af2a252ab9f9`)
- packages/keiko-server/src/editor/completionRoutes.ts:104 — open_unaddressed
- packages/keiko-server/src/gateway-setup.ts:2828 — acted_upon (commit `60ae0e3e26b4`)
- packages/keiko-server/src/gateway-setup.ts:3399-3402 — acted_upon (commit `af705c164551`)
- packages/keiko-server/src/gateway-setup.ts:3648-3649 — resolved_without_change
- packages/keiko-server/src/memory-handlers.ts:705 — acted_upon (commit `60ae0e3e26b4`)
- packages/keiko-server/src/run-handlers.ts:379-380 — open_unaddressed
- packages/keiko-server/src/store-handlers.ts:425-429 — open_unaddressed
- packages/keiko-server/src/update-local-state.ts:324-325 — acted_upon (commit `86a3e1af07e3`)
- packages/keiko-server/src/update-session-lock.ts:240-241 — acted_upon (commit `60ae0e3e26b4`)
- packages/keiko-server/src/update-session-lock.ts:243-245 — acted_upon (commit `60ae0e3e26b4`)
- packages/keiko-server/src/voice-recap.ts:271 — acted_upon (commit `86a3e1af07e3`)
- packages/keiko-ui/src/app/components/desktop/modals/GatewaySetupDialog.tsx:331-333 — open_unaddressed
- packages/keiko-ui/src/app/components/desktop/widgets/panels/SettingsPanel.tsx:1701 — acted_upon (commit `af705c164551`)

## Aggregate across 3 pull request(s)

| Bot               | Posted | Distinct | Duplicates | Notices | Files | Resolved | Unresolved | Outdated | Unique | vs Keiko for Quality | vs CodeRabbit | vs Codex | All three |
| ----------------- | ------ | -------- | ---------- | ------- | ----- | -------- | ---------- | -------- | ------ | -------------------- | ------------- | -------- | --------- |
| Keiko for Quality | 124    | 95       | 29         | 7       | 69    | 66       | 49         | 16       | 76     | —                    | 9             | 13       | 4         |
| CodeRabbit        | 53     | 53       | 0          | 0       | 37    | 53       | 0          | 0        | 41     | 9                    | —             | 7        | 4         |
| Codex             | 46     | 46       | 0          | 0       | 35    | 27       | 11         | 8        | 29     | 13                   | 7             | —        | 4         |

### Acted-upon linking (aggregate)

| Bot               | Distinct | Had opportunity | Acted upon | Resolved w/o change | Open unaddressed | Outdated/unmappable | Rate (raw) | Rate (adjusted) |
| ----------------- | -------- | --------------- | ---------- | ------------------- | ---------------- | ------------------- | ---------- | --------------- |
| Keiko for Quality | 95       | 85              | 64         | 13                  | 18               | 0                   | 67%        | 75%             |
| CodeRabbit        | 53       | 53              | 49         | 4                   | 0                | 0                   | 92%        | 92%             |
| Codex             | 46       | 42              | 32         | 4                   | 10               | 0                   | 70%        | 76%             |
