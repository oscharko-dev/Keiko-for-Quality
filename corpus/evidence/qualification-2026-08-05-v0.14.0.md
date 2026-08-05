# Qualification — v0.14.0 release candidate (2026-08-05)

Full 32-case run against dev `dd33cba` (the release tree), plus an isolated second-opinion rerun
per the CP-B doctrine. Redaction discipline as everywhere in this directory: counts, digests, ids —
no finding bodies, no model text.

**This qualification changes the model dimension.** v0.13.0 was measured against gpt-oss-120b;
this one runs gpt-5.4 over the consumer's own Azure AI Foundry deployment. A qualification is a
property of the pairing (engine + rule + model), so the per-case comparison against v0.13.0's table
below is informative, never a like-for-like delta — the recall improvement in the main run is as
attributable to the model as to the adapter.

## Binding

|               | Main run                | Second opinion + replication |
| ------------- | ----------------------- | ---------------------------- |
| adapter       | dev `dd33cba`           | same                         |
| engine        | `484a232e017c` (v1.8.4) | same                         |
| rule digest   | `9764590d3ad2`          | same                         |
| cases digest  | `b255cdcfde2a`          | same                         |
| scorer digest | `c78d6a280582`          | same                         |
| model         | gpt-5.4 (openai)        | same                         |

## Scoreboard

Main run: recall **27/28** seeded found · classified 26/27 (one off by one severity step) ·
precision **4/4** clean silent · publishable **32/32** · noise 1 · 550,274 tokens (17,196/case).

One miss: `workflow-head-checkout`.

**Net: 28/28 seeded defects found across main + second opinion, 4/4 clean silent, 32/32
publishable.**

## The one miss, and why it is not a regression

`workflow-head-checkout` missed the main run at 6,036 tokens — well under this run's 17k/case mean,
which is the signature of the engine returning no findings at all rather than returning wrong ones.
An isolated rerun reproduced the miss at _exactly_ 6,036 tokens, and two identical failures are
easy to over-read as determinism. They are not: a no-findings response is short and near-constant
in length, so the token count repeats for the same reason an empty file has the same size twice.

The differential experiment, run because the identical repeat looked like a dispatch regression
from this release's own audit work:

| Adapter                          | Result                      | Tokens |
| -------------------------------- | --------------------------- | ------ |
| v0.13.0 tag `86cd076`            | PASS (misclassified)        | 14,262 |
| dev `e8680ef` (#115 only)        | PASS (classified correctly) | 15,242 |
| dev `dd33cba` (#116) — attempt 1 | PASS (misclassified)        | 14,306 |
| dev `dd33cba` (#116) — attempt 2 | MISS                        | 6,036  |
| dev `dd33cba` (#116) — attempt 3 | PASS (misclassified)        | 14,210 |

Three replications on the release tree: **2/3 PASS**. The case roams, and it roams on the release
tree exactly as it roamed before — v0.13.0's own evidence records this same case as
`roaming (3/3 missed in CP-B; passes today)`. The corpus harness invokes the engine directly with
neither a budget nor an exclude list, so this release's dispatch, settlement, and cache changes are
not even in the path that produces the engine's finding list; the rule and engine digests are
identical across every row above.

Recorded rather than smoothed over: the first two observations genuinely looked like a regression,
and the differential is what distinguished a roaming case from a broken one. A single rerun would
not have been enough.

## Promotion conditions

Met. Severe recall holds across main + second opinion (28/28), precision 1.0, publishable 1.0, and
no rule change is involved — the rule digest is unchanged from the shipped economy rule.

## Deterministic lanes

`npm run verify` on the release tree: typecheck, lint, format:check, 1,353 vitest tests across 49
files, 203 corpus-lane tests, build, and `check:bundle` — all green.
