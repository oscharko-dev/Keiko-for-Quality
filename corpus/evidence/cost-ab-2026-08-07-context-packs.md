# Cost A/B — deterministic context packs (2026-08-07, pre-v0.20.0)

Measures the change that moves repository navigation out of the model's paid rounds: per-file
`git grep` context packs injected by the loopback proxy into the first user message, the change
intent moved from a proxy splice to the engine's native `--background`, and rule text that tells
the model to consult the pack first and batch what it still searches for. Motivated by the
2026-08-07 finding that 68% of model requests across 45 real runs were tool-driven navigation
(1,476 `code_search`, 525 file reads), and by the pinned engine's own source: `code_search` IS
`git grep` (`internal/tool/code_search.go`, v1.8.4) — a deterministic, zero-token lookup the
model was triggering through full-priced rounds.

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

## A/B on the Keiko#3011 merge (`0bbae51c`, 19 files)

The commit is the product's own worst documented case (CI 1.76M tokens settling `engine_error`
on 2026-08-06; 1.63M locally settling `coverage_gap`), reviewed via `corpus/real-diffs.mjs` —
the shared `performLocalReview` pipeline — with binding held constant. Baseline is `dev` at
3f4b560.

|              | baseline (dev)     | packs on every file (b91018c) | packs ≥50 changed lines (47b3d67) |
| ------------ | ------------------ | ----------------------------- | --------------------------------- |
| outcome      | complete, 19 files | complete, 19 files            | complete, 19 files                |
| findings     | 0                  | 0                             | 0                                 |
| total tokens | 1,478,981          | 1,801,199 (+21.8%)            | VVV_V2_TOKENS_VVV                 |
| wall-clock   | 2:29               | 1:52 (−25%)                   | VVV_V2_TIME_VVV                   |

## Reading the first candidate honestly

Pack-every-file _lost_ on tokens while _winning_ on wall-clock, and both facts are the same
mechanism seen from two sides: the packs replace navigation rounds (fewer round trips — a
quarter of the wall-clock gone), but with no provider cache each pack byte is resent on every
turn of its file's conversation, and most of this commit's nineteen files conclude in a handful
of cheap rounds where the pack's standing cost exceeds the one round it could have saved. The
consumer's own caveat, recorded before this work started, held: this is a cost lever to be
measured, not assumed — and the first shape measured _negative_ on this endpoint.

The correction prices packs only where an avoided round is expensive: files at or above the
engine's own plan-mode threshold (50 changed lines — the engine's `PLAN_MODE_LINE_THRESHOLD`
quantity at the engine's value), which on this commit is 5 files of 19. Below it a file gets no
pack, no rule-text change beyond the shared paragraphs, and exactly yesterday's conversation.

VVV_V2_READING_VVV

## What this deliberately does not claim

No completion-rate improvement is claimed anywhere in this change. The failed runs in the
45-run corpus had the LOWEST search rates; nothing measured here contradicts or supports a
completion effect, and the completion gate (`npm run corpus:completion`) remains the release
requirement it already was.

## Spend

Probe ~12k tokens; baseline 1,478,981; candidate v1 1,801,199; candidate v2 VVV_V2_TOKENS_VVV.
Standing development authorization.

---
