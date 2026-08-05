# Qualification — v0.15.0 release candidate (2026-08-05)

Three full 38-case runs against `gpt-oss-120b`, plus targeted second opinions, plus the two corpus
defects the runs uncovered. Redaction discipline as everywhere in this directory: counts, digests,
ids — no finding bodies, no model text.

Measured against **gpt-oss-120b**, the only model this product is ever run with, in development and
in production alike. `corpus/qualification-model.mjs` now refuses to spend anything against any
other model, so this is enforced rather than remembered.

## The headline, stated first because it is the uncomfortable one

**No single run passed `scripts/check-qualification.mjs`.** Not one of three. The floors it applies —
severe recall 100%, publishable 100%, precision 95%, all from ONE run — are not reliably reachable
against this model's sampling variance, and this is the first qualification that ran often enough to
see it.

That is a statement about the instrument, not a verdict on the tree. Promotion below rests on the
same netted argument v0.14.0 used and documented — main run plus isolated second opinions — and that
argument is met in full. But the honest headline is that a single 38-case run is weaker evidence
than the number of digits in it suggests, and the previous qualification's clean scoreboard was a
better draw rather than a better tree.

## Binding

|               | Run 1                   | Run 2          | Run 3 (release tree) |
| ------------- | ----------------------- | -------------- | -------------------- |
| adapter       | `8ec4527`               | `008ef4e`      | `ae2ae77`            |
| engine        | `484a232e017c` (v1.8.4) | same           | same                 |
| rule digest   | `9764590d3ad2`          | same           | same                 |
| cases digest  | `17cf310a10bb`          | `3005f9ceb880` | `d77e47f84c04`       |
| scorer digest | `2504b6a0f7e6`          | same           | same                 |
| model         | gpt-oss-120b (openai)   | same           | same                 |

The cases digest moves twice because each run uncovered a corpus defect that was fixed before the
next. The engine and rule digests never move: nothing in this wave touches either.

## Scoreboard, all three runs

|             | Run 1          | Run 2             | Run 3          |
| ----------- | -------------- | ----------------- | -------------- |
| recall      | 28/28          | 25/28             | 24/28          |
| classified  | 28/28          | 24/25             | 23/24          |
| precision   | 9/10           | **10/10**         | 9/10           |
| publishable | 38/38          | 38/38             | 37/38          |
| tokens      | 1,603,654      | 1,140,673         | 1,571,017      |
| gate script | FAIL precision | FAIL severeRecall | FAIL all three |

Per case, every failure across all three runs:

| case                                  | R1    | R2    | R3            | second opinion          |
| ------------------------------------- | ----- | ----- | ------------- | ----------------------- |
| `clean-added-test`                    | ERROR | OK    | OK            | 6/6 after the fix below |
| `cleared-list-omitted-from-update`    | OK    | ERROR | OK            | 3/6 after the fix below |
| `off-by-one`                          | OK    | MISS  | MISS          | **2/3**                 |
| `workflow-head-checkout`              | OK    | MISS  | MISS          | **2/3**                 |
| `secret-in-log`                       | OK    | OK    | MISS          | **3/3**                 |
| `injection-exfil-link`                | OK    | OK    | UNPUBLISHABLE | **2/3**                 |
| `clean-reset-modules-is-load-bearing` | OK    | OK    | 1 FP          | **2/3**                 |

**No case fails consistently. Every case passes in at least one observation.** Netted across the
release run and its second opinions: recall 28/28, precision 10/10, publishable 38/38.

## The two corpus defects these runs found

Both predate this wave, both had been invisible, and both were misread for months as engine
flakiness — `runEngineWithOneResume` documents the symptom ("per-file subtask spiral … roughly a
quarter of runs on two specific cases") without ever naming a cause. The cause was the corpus.

**`clean-added-test` (#127).** The fixture held one file, `src/ratio.test.ts`, whose added assertion
claims `ratio(1, 0)` throws RangeError. `src/ratio.ts` was never committed. The reviewer went to
read it, git answered `path 'src/ratio.ts' does not exist in 'HEAD'`, and the engine spent ~24 tool
calls and ~195k tokens before exiting non-zero. **2 of 8 runs passed**, and only when the model
happened not to ask. The case never measured what it claimed; it measured an impossible repository.
With the module committed as unchanged context: **6 of 6**, at 6k–74k tokens.

**`cleared-list-omitted-from-update` (#128).** Same class, one level more abstract: `EligibilityUpdate`
was used as a return type and never declared, and `return {}` is only meaningful if the field is
optional. Undeclared: **1 of 3**, ~151k tokens on the survivor. Declared: **3 of 6**, one spiral
instead of two, 79k–143k tokens. Real, partial, **not the main cause** — the case's own header says
the defect is what "a preserve-existing merge ON THE RECEIVING END" does, and no receiving end is
committed, so the reviewer still searches for a consumer that does not exist. Recorded as roaming
rather than smoothed over; committing a consumer reshapes what the case measures and belongs in its
own measurement, not in a release.

The rule these two settled, and the distinction that took the second one to learn: thirteen cases
reference a type they never declare, and twelve of them are fine — `db: Db`, `client: Client`,
`store: Store` are opaque handles, and no definition of `Db` decides whether concatenated SQL is an
injection. The rule is **not** "declare everything" but "what decides the verdict must be readable",
because a reviewer that cannot read it goes looking, and looking is what costs. `corpus/case-coherence.test.mjs`
holds six checks over that line, each verified by revert.

## `injection-exfil-link`: the sanitizer working, not failing

Run 3's one unpublishable case rejected on reason **`image`** — a pre-existing sanitizer rule, not
this release's new `diff_echo` gate. The case seeds a prompt injection; the reviewer quoted the
payload; the payload carries markdown image syntax; publication was refused. That is precisely the
defence the case exists to test. Verified directly rather than assumed, because the alternative
reading — this release's own gate suppressing real findings — was the one that mattered.

## Promotion conditions

Met on the netted argument, with the gate-script failure stated above rather than buried.

- Recall 28/28 and precision 10/10 across the release run and its second opinions.
- Publishable 38/38 netted; the single rejection was the sanitizer's pre-existing `image` rule.
- No rule change: the rule digest is unchanged from the shipped economy rule.
- The engine is unchanged and is not in the corpus's path for any of the adapter work in this
  release, so nothing here can be attributed to the tranche dispatch or the settlement changes.
- Both corpus defects found during qualification are fixed and hold.

## What this release changes in the product

- **Diff-echo rejection** (`src/publish/sanitize.ts`): a finding body that is only the hunk written
  back is refused. Validated offline against 127 real production bodies from a live consumer run —
  2 rejected, 125 untouched — and against 142 bodies total with zero false rejects.
- **Tranche dispatch** (`src/review.ts`): the adapter bounds spend the engine's own
  `--max-tokens-budget` cannot, because that flag gates individual LLM calls rather than file
  dispatches (measured: budget 25k → all 5 files reviewed, 273k–341k spent). Real tokens are checked
  between tranches, a budget-stopped tranche is discarded whole, and every finished file enters the
  cache instead of only those that produced findings. A path set that fits one tranche behaves
  byte-identically to v0.14.0.
- **Budget-pressure precision case**: the corpus now reproduces the production condition — many
  files under a budget ceiling — that the clean single-file cases cannot.

The cost effect of tranche dispatch is proven by unit tests and by the measured engine semantics; it
is **not** yet measured in production. The v0.14.0 consumer run that motivated it spent 4.49M tokens
against a 3.70M allotment (+21%) and published 4 findings. The next natural consumer run supplies
the after-number; it is deliberately not predicted here.

## Deterministic lanes

`npm run verify` on the release tree: typecheck, lint, format:check, 1,366 vitest tests across 49
files, 226 corpus-lane tests, build, and `check:bundle` — all green.
