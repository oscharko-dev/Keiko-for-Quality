# Cost A/B — deterministic context packs (2026-08-07, pre-v0.20.0)

Measures the attempt to move repository navigation out of the model's paid rounds: per-file
`git grep` context packs injected by the loopback proxy into the first user message, plus the
change intent moved from a proxy splice to the engine's native `--background`. Motivated by the
2026-08-07 finding that 68% of model requests across 45 real runs were tool-driven navigation
(1,476 `code_search`, 525 file reads), and by the pinned engine's own source: `code_search` IS
`git grep` (`internal/tool/code_search.go`, v1.8.4) — a deterministic, zero-token lookup the
model was triggering through full-priced rounds.

**Outcome up front: the packs shipped OFF by default.** Four paid runs could not show a saving
on the live endpoint, and the same runs showed variance large enough that no single-run
comparison can license a default. The mechanism is built and tested; `KFQ_CONTEXT_PACKS=1`
enables it for deliberate experiments, and the economics that would flip the default belong to
the serving path, not to this code.

## The endpoint prices everything — probe first

Three identical requests with a 2,402-token shared prefix against the live Azure AI Foundry
gpt-oss-120b deployment (`/openai/v1`), then two more carrying `prompt_cache_key`:

| call                      | status                              | prompt tokens | cached                |
| ------------------------- | ----------------------------------- | ------------- | --------------------- |
| A/B/E (identical, no key) | 200                                 | 2,402         | field absent entirely |
| C/D (`prompt_cache_key`)  | 400 `unrecognized_request_argument` | —             | —                     |

No `prompt_tokens_details` in any response: this endpoint reports no caching and discounts
nothing, and the cache-routing key the proxy injects is refused outright (self-healed by the
existing latch at the cost of one 400 round per engine invocation). Every prompt byte therefore
rides every turn at full price — the economics Greptile publishes for its agentic loop (3× the
context at −75% the cost) are a _caching_ result and are not available on this serving path.
The fixture that shows `cache_read_tokens: 4992` predates this endpoint; it is not evidence
about it.

## Four runs on the Keiko#3011 merge (`0bbae51c`, 19 files)

The commit is the product's own worst documented case (CI 1.76M tokens settling `engine_error`
on 2026-08-06; 1.63M locally settling `coverage_gap`), reviewed via `corpus/real-diffs.mjs` —
the shared `performLocalReview` pipeline — binding, model (`gpt-oss-120b`), temperature 0 and
seed 42 held constant throughout. Baseline is `dev` at 3f4b560.

|              | baseline (dev) | packs ×19 files (b91018c) | packs ×5 files (47b3d67) | packs ×5, batching text removed (e4911eb) |
| ------------ | -------------- | ------------------------- | ------------------------ | ----------------------------------------- |
| outcome      | complete, 19   | complete, 19              | complete, 19             | complete, 19                              |
| findings     | 0              | 0                         | 0                        | **3**                                     |
| total tokens | **1,478,981**  | 1,801,199 (+21.8%)        | 1,843,482 (+24.6%)       | 2,575,339 (+74.1%)                        |
| wall-clock   | 2:29           | 1:52                      | ~2:30                    | 4:10                                      |

## What these four numbers do and do not support

**They do not support the intended conclusion, and the honest reading is about variance before
it is about packs.** Between candidates v1 and v2 the pack count fell from nineteen files to
five and total cost did not fall with it; between v2 and v3 one rule-text paragraph was removed
and cost rose 40% while the finding count went from zero to three. Under pinned sampling on one
fixed commit, changing any prompt byte reshuffles the model's tool-use path, and the resulting
spread — 1.80M to 2.58M tokens, zero to three findings — is wider than every effect this
experiment set out to measure. AGENTS.md already says this about the completion gate ("read it
as a rate and never as a verdict"); this evidence file says it about cost: **a single-run A/B
on this pipeline is not a measurement of a configuration, it is one sample of a distribution.**
The intermediate commit messages on this branch (47b3d67, e4911eb) each drew a conclusion from
the run before them; this file supersedes both readings.

What the runs DO establish:

- No pack configuration beat the baseline's cost on this endpoint. The one directional claim
  the data supports is that with no prompt caching, added prompt bytes and reshuffled paths
  have real, immediate cost and no measured saving here outweighed them.
- Every run settled `complete` on all nineteen files — the injection mechanics (proxy splice
  into the first user message, `--background`, the ≥50-changed-lines gate) are functionally
  sound and never harmed a review.
- The v3 run's three findings are one sample, not evidence that packs improve recall — exactly
  as the consumer's own caveat, recorded before this work started, forbids claiming.

## The decision

- `KFQ_CONTEXT_PACKS` defaults off; `dispatchContextPacks` returns an empty map unless a
  deliberate experiment sets it to `1` (the `OCR_ALLOW_MODEL_DEVIATION` pattern).
- The `--background` migration ships: it is prompt-position-stable where the old splice moved
  with the conversation, it reaches the anthropic path the proxy never covered, and the local
  measurement path carries no intent at all, so it contributed nothing to the numbers above.
- The rule text keeps the short `<repository_context>` paragraph (truthful — the block "may"
  follow — and the description the model needs whenever the opt-in is on). The wide-read
  batching paragraph tried in v1/v2 stays out; the code comment at its former site carries the
  numbers so it is not reintroduced as an obvious improvement.
- Flipping the default requires either a serving path that discounts stable prefixes (then the
  pack's standing cost approaches zero and the avoided rounds are pure saving — the ops
  question tracked separately), or an n≥3-per-configuration measurement program, which is a
  budget decision recorded here rather than made unilaterally.

## What this deliberately does not claim

No completion-rate improvement is claimed anywhere in this change, and no recall effect is
claimed from v3's three findings. The completion gate (`npm run corpus:completion`) remains the
release requirement it already was.

## Spend

Probe ~12k tokens; four review runs 1,478,981 + 1,801,199 + 1,843,482 + 2,575,339 = 7,699,001
tokens. Standing development authorization.

---
