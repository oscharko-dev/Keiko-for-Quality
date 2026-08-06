# Qualification — v0.18.0 release candidate (2026-08-06)

One full 39-case run against `gpt-oss-120b`, plus one isolated second opinion per failure —
the promotion pattern v0.15.0 established and documented. Redaction discipline as everywhere in
this directory: counts, digests, ids — no finding bodies, no model text.

Measured against **gpt-oss-120b**, the only model this product is ever run with, in development
and in production alike; `corpus/qualification-model.mjs` enforces it.

## What this release changes, and why the corpus still binds it

v0.18.0 is the Keiko#3002 settlement wave: the engine's full stdout status vocabulary
(`completed_with_warnings` / `completed_with_errors` / `budget_exceeded`) parsed instead of folded
to `unknown`, warning-named per-file failures settled as a coverage gap that keeps its verdicts,
no resume of a finished run, and the observability that would have named all of this on run one
(`engine.status.*`, gap counts in the log line and the notice, five-way store-rejection reasons,
honest proxy 400 accounting). The rule text did NOT change (`rule 4fd942dbdb8d`, unchanged from
the v0.15.0 wave) and the engine pin did not move, so recall/classification movement below is
sampling, not configuration. What the corpus newly binds is the settlement path every case's
result now flows through — a `completed_with_errors` fixture captured from the live Keiko#3002
re-run is part of the hermetic suite as of this wave.

## Binding

|               | Main run                | Second opinions |
| ------------- | ----------------------- | --------------- |
| adapter       | `211c28f` (dev)         | same tree       |
| engine        | `484a232e017c` (v1.8.4) | same            |
| rule digest   | `4fd942dbdb8d`          | same            |
| cases digest  | `8e9946d6ecc7`          | same            |
| scorer digest | `acd8bfc4ef45`          | same            |
| model         | gpt-oss-120b (openai)   | same            |

## Scoreboard, main run

|             | Main run  |
| ----------- | --------- |
| recall      | 27/29     |
| classified  | 27/27     |
| precision   | 8/10      |
| publishable | 39/39     |
| tokens      | 1,231,513 |

One case threw before reaching the model (harness/connection, not a review miss) — the same
failure mode v0.15.0 recorded twice for the same case.

## Per case, every failure, with its isolated second opinion

| case                                  | Main run | Second opinions        | v0.15.0 precedent             |
| ------------------------------------- | -------- | ---------------------- | ----------------------------- |
| `missing-timeout`                     | MISS     | **PASS**               | rotating recall dropout class |
| `cleared-list-omitted-from-update`    | ERROR    | **PASS**               | ERROR in R2 there too         |
| `clean-added-test`                    | 1 FP     | **PASS**               | ERROR in R1 there             |
| `clean-reset-modules-is-load-bearing` | 1 FP     | 1 FP, 1 FP — see below | 1 FP in R3 there, SO 2/3      |

**Three of the four failures pass on their first isolated retry.** The fourth did not, and gets
its own paragraph instead of a hand-wave.

### `clean-reset-modules-is-load-bearing`, stated in full

Three observations on this tree today, three false positives (37,413 / 24,457 / 23,767 tokens —
the spread itself is the serving-side variance). A **control run of the identical case on the
v0.17.0 tree** (`9aefd58`) came back silent (6,403 tokens) under the same binding line — engine,
rule, cases, and scorer digests all byte-identical, which they must be: nothing in the v0.18.0
wave touches the rule text, the engine pin, or any byte the model sees. There is no channel
through which this release's settlement/observability changes could alter a review verdict; the
control run is an observation of the same prompt path this release ships. Netted across today's
control and the v0.15.0 wave (2 clean passes, 1 FP, second opinions 2/3), the case passes in
multiple observations of this exact configuration — but today's 3/3 FP streak on this tree is the
worst draw yet recorded for it, and the case's stability against this model is now an open
calibration question tracked as follow-up work for the next wave, not something this document
nets away silently.

The single-run gate floors remain unreachable against this model's serving-side variance
(temperature 0 and a pinned seed do not remove it — v0.15.0's own headline, re-measured here).
Promotion rests on the net, stated rather than implied — and on what this release actually
changes: the production defect it fixes (Keiko#3002, eight finished reviews discarded as engine
failures) is verified end to end against the live pull request's own diff, and shipping that fix
does not touch the judgement path this corpus measures.

## Spend

Main run 1,231,513 tokens (31,577/case); six isolated follow-up runs (four second opinions, one
third opinion, one v0.17.0-tree control) add roughly 160k more. All spend against the standing
development authorization for qualification runs.
