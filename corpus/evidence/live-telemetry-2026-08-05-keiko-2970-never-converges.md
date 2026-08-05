# Live telemetry — twenty incomplete runs, one reason code, zero clean settlements (2026-08-05)

Two live pull requests on oscharko-dev/Keiko, reviewed by the v0.13.0 pin (`86cd076e`) across one
day: **Keiko#2981** (13 runs) and **Keiko#2970** (4 runs, plus the earlier v0.12.0 pair recorded in
`live-telemetry-2026-08-04-keiko-2981-double-run.md`). Every single one settled incomplete. Every
single one published `settlement.incomplete.engine_status_not_success`. Not one clean review.

This document records the measurement that named the cause, and the four fixes it drove. Redaction
discipline as everywhere in this directory: counts, digests, ids — no finding bodies, no model text.

## The run that gave up the whole chain (Keiko#2970, `94db4530`, 21:56Z)

Read top to bottom, the diagnostics stream contradicts itself:

| Diagnostic                              | Counts                                                           |
| --------------------------------------- | ---------------------------------------------------------------- |
| `inventory.completed`                   | total 42, reviewable 37, reviewed 37, excluded 5                 |
| `cache.store_loaded`                    | entries 44                                                       |
| `cache.hits`                            | hits **0**, misses 37                                            |
| `cache.context_invalidated`             | invalidated 9                                                    |
| `engine.run.completed`                  | budget **3,436,732**, 288,825 ms                                 |
| `model.usage`                           | requests 338, prompt 3,707,490, completion 136,306, cached **0** |
| `engine.resume_skipped_budget_exceeded` | spent **3,843,796**, allotted 3,436,732                          |
| `settlement.mode.counted`               | —                                                                |
| `settlement.incomplete.…`               | **`engine_status_not_success`**                                  |
| `run.spend`                             | engine 3,843,796, classify 16,769, total 3,860,565               |

The engine ran out of budget — `engine.resume_skipped_budget_exceeded` fires only on
`parsed.budgetExceeded` — and the settlement reported a bare status failure. Those are the same
event, described twice, and only one of the two descriptions reached the pull request.

## The causal chain

1. **The reason code named the symptom, not the cause.** `--max-tokens-budget` makes the engine stop
   dispatching and exit non-`success`, so a budget stop arrives carrying BOTH facts. `settleCounted`
   checked `status` first and claimed it, so the notice said "the engine did not say success" —
   which tells a consumer nothing they can act on. Twenty runs, one code, and the one number that
   would have ended it (`token_budget` was 6,000,000; the run was held to 3,436,732) never surfaced.
   _Fixed: `budgetDisqualifier` runs ahead of the status and terminal-state branches in both
   settlement modes (`engine/settle.ts`)._

2. **The misdiagnosis also discarded the run's paid-for verdicts.**
   `verdictsSurviveIncompleteness` admits `budget_exceeded` and denies `engine_status_not_success`,
   and rightly: a bad terminal state means the manifest is not to be believed. Under the wrong code,
   every truncated run stored nothing, so the next push re-priced all 37 files from zero and
   truncated in the same place. _Fixed by the same reordering._

3. **Even under the right code, truncation persistence was inert on the released engine.**
   `coveredPaths` reads the run manifest, and no published engine release emits one — so the covered
   set was always empty in counted mode and Keiko-for-Quality#75 had never written an entry in
   production. A finding is the missing identity: the engine cannot report a defect in a file it
   never opened. _Fixed: `memoizablePaths` (`engine/settle.ts`) unions the manifest coverage with
   the paths of surviving findings, minus anything the manifest explicitly failed._

4. **The allotment was calibrated on the wrong statistic.** 37 files priced at 3,436,732 and cost
   3,843,796 — 103.9k/file against a 64k/file constant chosen as the live _median_. The allotment
   prices `N` files at once, and a sum of `N` draws concentrates around `N x mean`, not `N x median`;
   on this spread the mean is well above. A median-calibrated ceiling is one the typical multi-file
   run is expected to cross. _Fixed: `PER_FILE_TOKENS` 64k→100k, the mean of the four live points._

## Accumulated live cost points (n=4)

| Run        | Files |    Tokens | Tokens/file | Character        |
| ---------- | ----: | --------: | ----------: | ---------------- |
| Keiko#2980 |     1 |    31,778 |         32k | profile JSON     |
| Keiko#2981 |    55 |     3.56M |        ~65k | mixed feature PR |
| Keiko#2970 |    37 | 3,843,796 |    **104k** | mixed feature PR |
| Keiko#2971 |     5 |   998,192 |       ~200k | dense TS code    |

Mean 100.2k. At 100k/file the #2970 run's allotment is 5,168,332 against a real 3,843,796 spend,
inside the consumer's own 6M ceiling, and it completes.

The asymmetry that settles the calibration argument: `--max-tokens-budget` is a **ceiling, not an
allocation**. A run that does not need the headroom never spends it, so widening it costs nothing on
every run that was going to fit — while hitting it costs the entire run and (before fix 3) the next
one as well. Under-provisioning is not the cheap side of this trade.

## Publication volume, measured against the other reviewers on Keiko#2981

| Reviewer          | Comments | Blocking "not reviewed" notices |
| ----------------- | -------: | ------------------------------: |
| Keiko for Quality |       66 |                          **13** |
| Codex             |       26 |                               0 |
| CodeRabbit        |       18 |                               0 |

The 13 notices are fixes 1–4's problem. The comment volume is its own: the same unfixed objection
was filed three times against one file across three pushes, and the same "removed i18n keys break
their consumers" objection five times — each at a drifted line, each as a fresh blocking
conversation the author then had to resolve by hand.

Cause: every cross-run dedup stage that judges wording matches on a line anchor, and GitHub nulls a
thread's anchor once a push marks it outdated. So an outdated thread is invisible to all of them —
correct for a location-matching stage, and the reason a long-lived pull request accumulates one new
conversation per push for one defect. _Fixed: `findsOutdatedRecurrence` (`publish/similarity.ts`), a
coordinate-free stage restricted to still-open outdated threads, at a raised bar on both similarity
bounds (0.70 overlap, 8 shared content words) since the body carries the decision alone. A genuinely
RESOLVED thread still never silences a recurrence — Keiko-for-Quality#38's contract is untouched._

Measured separation on the real bodies, after this repository's own tokenizer: the genuine
restatement pair scores 0.71 / 10 shared words; the nearest false positive — a different defect in
the same sentence template — scores 0.50 / 6. Each bound separates them on its own.

## One reporting defect the previous evidence file recorded without naming

`live-telemetry-2026-08-04-keiko-2981-double-run.md` closes by quoting the summary's budget line as
candid: `"80000 allotted, 3562109 reported"`. It was not candid — it was wrong. `extractBudget` took
the LAST `engine.run.completed`, and a resumed run emits one per attempt with the second carrying
the remainder carved out of the first. 80,000 was the resume's own floor; the run's real allotment
was 2.97M. The line put a per-attempt ceiling next to a cumulative spend and read as a 44x overrun
that never happened. _Fixed: first attempt wins (`publish/summary.ts`)._

## What still holds, and what is still open

Held: eligibility gating, the honest incomplete notice, the self-healing cache-key latch, the
engine-digest pin, and the run summary's structure.

Open, unfixed, and deliberately not bundled here:

- **Provider caching is still dead on this deployment.** `cached_tokens` 0 across 338 requests and
  3.7M prompt tokens, on every run in this document and the last. `prompt_cache_key` is injected and
  the gateway does not discount. This is an infrastructure decision (a deployment with real prefix
  caching, or the anthropic path), not something the product can fix from inside.
- **Superseded notices are never cleaned up.** Thirteen blocking conversations about commits no
  longer in the branch remain open on Keiko#2981, each needing a manual resolve under the
  conversation-resolution branch protection. Auto-resolving one's own superseded notices needs a
  GraphQL mutation this client does not have, and is a visible behaviour change worth deciding
  deliberately rather than shipping inside a fix bundle.
