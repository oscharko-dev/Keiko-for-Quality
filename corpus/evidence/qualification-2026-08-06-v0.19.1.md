# Qualification — v0.19.1 release candidate (2026-08-06)

Third wave of the day. One full 39-case run against `gpt-oss-120b` on the release tree, isolated
opinions per failure. Redaction discipline as everywhere here.

## What this release changes

v0.19.1 is the Keiko#3008 response: a second proxy healing stage (a 400 surviving the keyless
retry gets one attempt as the engine's ORIGINAL body; cures are counted as `rewrite_rejected`),
pattern-matched 400 class counters (`content_filter` / `unknown_parameter` / `context_length`),
and complement memoization (a finished run covers dispatched−failed, not only finding-proven
paths — #3008 memoized 0/12 for want of it). Happy-path model bytes are untouched: the healing
fires only on a 400, and the binding line below is byte-identical to the v0.19.0 qualification.

## Binding

engine `484a232e017c` (v1.8.4) · rule `5e302d88128a` · cases `437536225fb1` · scorer
`acd8bfc4ef45` · model gpt-oss-120b (openai) · adapter: dev tip carrying #150.

## Scoreboard

recall **27/29** · classified **27/27** · precision **10/10** · publishable **39/39** ·
1,733,183 tokens. No harness throws — and the first fully clean precision run of all three waves.

## Per failure

| case                     | Main run    | Isolated    | Passing observation under this binding        |
| ------------------------ | ----------- | ----------- | --------------------------------------------- |
| `unevidenced-claim`      | UNEVIDENCED | **PASS**    | plus two isolated passes earlier today        |
| `workflow-head-checkout` | MISS (6.4k) | MISS (6.5k) | **PASS in the v0.19.0 main run** (same bytes) |

`workflow-head-checkout` did not land an isolated pass today (0/2, both instant-exit token
counts), and this document does not pretend otherwise. Its passing observation under this exact
binding is the v0.19.0 main run a few hours earlier — rule, cases, engine, and scorer digests all
identical — and its v0.15.0 record (OK/MISS/MISS, isolated 2/3) predates every change of both
waves. The case joins the known-rotator list; if it stays dry next wave, it needs the
clean-reset-style calibration pass rather than more draws.

## Spend

Main run 1,733,183 tokens; two isolated opinions add ~87k. Standing development authorization.
