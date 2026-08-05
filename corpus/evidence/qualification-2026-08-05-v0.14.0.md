# Qualification — v0.14.0 release candidate (2026-08-05)

Full 32-case run against dev `4ff8fbe` (the release tree, v0.14.0), plus isolated second-opinion
reruns and a differential against the previous release per the CP-B doctrine. Redaction discipline
as everywhere in this directory: counts, digests, ids — no finding bodies, no model text.

Measured against **gpt-oss-120b**, the only model this product is ever run with — in development
and in production alike. An earlier attempt at this qualification was run against a different chat
model and discarded: a qualification is a property of the pairing (engine + rule + model), so a run
against a model the product never uses measures nothing about the product that ships.

## Binding

|               | Main run                | Second opinions + replication |
| ------------- | ----------------------- | ----------------------------- |
| adapter       | dev `4ff8fbe`           | same                          |
| engine        | `484a232e017c` (v1.8.4) | same                          |
| rule digest   | `9764590d3ad2`          | same                          |
| cases digest  | `b255cdcfde2a`          | same                          |
| scorer digest | `c78d6a280582`          | same                          |
| model         | gpt-oss-120b (openai)   | same                          |

## Scoreboard

Main run: recall **26/28** seeded found · classified **26/26** (every found defect carried the
expected category and severity) · precision **4/4** clean changes left silent · publishable
**32/32** · noise 1 · 1,122,113 tokens (35,066/case).

Two misses: `off-by-one` and `workflow-head-checkout`.

- `off-by-one` — second opinion **PASS**, classified correctly (16,632 tokens).
- `workflow-head-checkout` — see below.

**Net: 27/28 seeded defects found across main + second opinion, with the 28th a documented roaming
case that passes the release tree more often than it passed the previous release's tree. Precision
4/4, publishable 32/32.**

Against v0.13.0's own main run (recall 21/28, classified 20/21), this is a better main-run result
on the identical model, engine, and rule.

## `workflow-head-checkout`: roaming, and no regression

Replicated on both trees under gpt-oss-120b, because two consecutive misses read like a dispatch
regression from this release's audit work:

| Adapter                 | Observations                 | Pass rate |
| ----------------------- | ---------------------------- | --------- |
| dev `4ff8fbe` (v0.14.0) | FAIL, FAIL, PASS, PASS, FAIL | **2/5**   |
| v0.13.0 tag `86cd076`   | FAIL, PASS, FAIL             | **1/3**   |

The case roams on **both** trees, and the release tree passes it at a higher rate than the tree it
replaces. v0.13.0's own evidence already records this same case as
`roaming (3/3 missed in CP-B; passes today)`.

Two structural facts rule out this release's changes as the cause. The corpus harness invokes the
engine directly with neither a budget nor an exclude list, so this release's dispatch, settlement,
and cache changes are not in the path that produces the engine's finding list at all. And the
engine and rule digests are identical across every row above — the only moving part is the model's
own sampling.

The failing runs cluster at ~6.1k tokens, which is the near-constant length of a no-findings
response rather than evidence of determinism; one failing run reached 12.7k, so the engine
sometimes does the work and still declines to report. Recorded rather than smoothed over: two
identical-looking failures are not a reproduction, and only the differential distinguished a
roaming case from a broken one.

## Promotion conditions

Met. Classification is perfect on every found defect (26/26), precision is 1.0, publishable is 1.0,
recall improves on the previous release under the identical pairing, and no rule change is involved
— the rule digest is unchanged from the shipped economy rule.

## Deterministic lanes

`npm run verify` on the release tree: typecheck, lint, format:check, 1,353 vitest tests across 49
files, 203 corpus-lane tests, build, and `check:bundle` — all green.
