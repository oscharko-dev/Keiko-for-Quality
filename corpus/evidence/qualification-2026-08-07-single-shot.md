# Qualification — single-shot mode (2026-08-07, feat/single-shot-review)

Measures the one-call-per-file runner (`src/engine/single-shot.ts`, `KFQ_SINGLE_SHOT=1`) on the
frozen qualification basis: identical fixtures, identical production-built rule, identical
graders and publisher stage, identical resume mirror — the harness's one invocation seam routes
to the shipped runner and nothing else changes (binding: engine ec3c7adf9284 = sha256 of the
runner source, rule a7c82ae3d8c5, cases 437536225fb1, model gpt-oss-120b).

## Scoreboard, against both agentic waves

|                               | v0.19.2 (30 rounds) | tool-rounds wave (60) | **single-shot**          |
| ----------------------------- | ------------------- | --------------------- | ------------------------ |
| recall                        | 27/29               | 28/29                 | **28/29**                |
| classified                    | 27/27               | 26/28                 | 27/28 (1 one step off)   |
| precision (clean left silent) | 10/10               | 10/10                 | 9/9 measured — see below |
| publishable                   | 39/39               | 39/39                 | **39/39**                |
| noise                         | 1                   | 2                     | 3                        |
| **total tokens**              | 2,207,077           | 1,605,843             | **289,525 (−82%)**       |
| tokens per severe hit         | 84,888              | 59,476                | **10,723**               |

## The completion side, measured the same day

- Completion gate, CLI path, Keiko#3011 (19 files), n=3: **100% (3/3 complete, 19/19 files
  each)**, ~136k tokens per run, the substantiate stage visibly dropping a vague finding on the
  way. The agentic history on this same pull request: 1.76M settling `engine_error` in CI, 1.63M
  settling `coverage_gap` locally, and 2.17M settling `coverage_gap` twice while reviewing this
  product's own #173.
- Consumer seed gate, CLI path, throwaway worktrees: **GREEN** — every required case found
  (tier-1, tier-2, and the ALIBI twin), line-anchored in the seeded file, noise 0, 7/7 attempts
  complete, 59,946 tokens for the whole gate. Missed: the two advisory tier-2 rotators
  (`normalise-flag-familiar`, `bootstrap-mode-two-push`).

## Per failure, honestly

- `workflow-head-checkout`, MISSED — the corpus's long-standing rotator, dry in the 60-round
  agentic wave too. It stays on the rotator list; nothing about this mode caused it.
- `budget-starved-clean-neighbours`, 1 unwanted finding — **unmeasured by the harness's own
  ruling**: the case exists to apply budget pressure (allotted 25,000) and the run finished
  without `budget_exceeded`, so the WARNING the harness prints ("the pressure this case exists
  to apply never arrived; treat its verdict as unmeasured") applies verbatim. The single-shot
  budget stop acts BEFORE dispatch on wire-observed spend, so this case needs a tighter
  allotment to exert pressure on this runner — a harness calibration follow-up, not a verdict.
- Classification lost one severity step on one finding (27/28 against 27/27 at 30 rounds,
  26/28 at 60) — the same soft-metric band both agentic waves moved in.
- Noise rose to 3 against 1–2 agentic. Soft metric, none of it unpublishable, all of it graded
  through the real publisher — recorded here as the one line to watch across the next waves,
  exactly as the 60-round wave recorded its own noise uptick.

## Wave two, same day — the twice-in-a-row reading

|                       | wave 1  | wave 2    |
| --------------------- | ------- | --------- |
| recall                | 28/29   | 27/29     |
| classified            | 27/28   | **27/27** |
| publishable           | 39/39   | 39/39     |
| noise                 | 3       | 3         |
| total tokens          | 289,525 | 298,136   |
| tokens per severe hit | 10,723  | 11,467    |

Both waves sit in exactly the band the two agentic waves span (27–28 of 29, noise steady,
publishability perfect, spend within 3% of itself). The rotation rotated, as it always has:
`workflow-head-checkout` (missed in wave 2's main run, missed by both agentic main waves)
**passes in isolation** under this mode — the first time the long-standing rotator has been
found at all this week. `cleared-list-omitted-from-update`, found in wave 1, went dry in wave
2's main run AND in isolation (two consecutive dry reads): recorded as this mode's own rotator
candidate and the single specific case to watch, alongside the noise-3 line. The
budget-starved case repeated its unmeasured verdict for the same calibration reason as wave 1.

## What this run establishes, and what it does not

Two waves in one day establish that the one-call-per-file architecture holds the agentic recall
band (27–28/29) with perfect publishability, steady spend, line-anchored findings without a
relocation pass, a measured 100% completion rate, and roughly a fifth of the cheaper agentic
wave's cost. What remains before a default flip is process, not evidence volume: a
release-shaped run under the release checklist, the `cleared-list-omitted-from-update` rotator
watched, the noise-3 line watched, and the budget-starved case recalibrated to prices at which
its pressure can actually arrive.

## Spend

Wave 1 289,525 + wave 2 298,136 + isolations 13,442 + completion gate n=3 412,229 + seed gate
59,946 + probe 7,813 + smoke 132,132 = 1,213,223 tokens. Standing development authorization.

---
