# Qualification — v0.13.0 release candidate (2026-08-04)

Full 32-case run against dev `8d05ee0` (the release tree), plus isolated second-opinion reruns per
the CP-B doctrine. One measurement-apparatus defect was found BY this run, fixed, and the affected
cases re-measured; both scorer digests appear below. Redaction discipline as everywhere in this
directory: counts, digests, ids — no finding bodies, no model text.

## Binding

|               | Main run                | Reruns (after harness alignment)                                                                                           |
| ------------- | ----------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| adapter       | dev `8d05ee0`           | dev `8d05ee0` + corpus-harness alignment                                                                                   |
| engine        | `484a232e017c` (v1.8.4) | same                                                                                                                       |
| rule digest   | `9764590d3ad2`          | same                                                                                                                       |
| cases digest  | `5ef8ecbc36cc`          | `bc9d5101552b` (two `defect.file` anchors moved to the CHANGED file, pin-desync gained the gate's own phrasing as anchors) |
| scorer digest | `0f702743b632`          | `c48a97d97e84`                                                                                                             |
| model         | gpt-oss-120b (openai)   | same                                                                                                                       |

## Scoreboard

Main run: recall 21/28 seeded found · classified 20/21 (one off by one severity step) · precision
4/4 clean silent · publishable 32/32 · noise 3 · 892,800 tokens (27,900/case).

Isolated second opinions (8 cases, ~360k tokens): **all eight PASS.**

| Case                                 | Main           | Rerun           | Reading                                         |
| ------------------------------------ | -------------- | --------------- | ----------------------------------------------- |
| contract-response-field-dropped      | MISS           | **PASS** (87k)  | harness gap, closed (below)                     |
| status-union-widened-consumer-missed | MISS           | **PASS** (75k)  | harness gap, closed                             |
| pinned-reference-duplicate-desync    | MISS           | **PASS** (6k)   | harness gap + anchor vocabulary, closed         |
| off-by-one                           | MISS           | **PASS** (23k)  | roaming serving dropout (documented since CP-B) |
| missing-timeout                      | MISS           | **PASS** (15k)  | roaming                                         |
| workflow-head-checkout               | MISS           | **PASS** (23k)  | roaming (3/3 missed in CP-B; passes today)      |
| swallowed-error                      | no result line | **PASS** (15k)  | transient throw, proven transient               |
| cleared-list-omitted-from-update     | no result line | **PASS** (109k) | same (also threw in CP-B, passed its rerun)     |

**Net: 28/28 seeded defects found across main + second opinion, 4/4 clean silent, 32/32
publishable.** Total qualification spend ≈ 1.25M tokens.

## The apparatus defect this run caught

`corpus/run.mjs`'s gate merge still called the W5-era `compareContracts` only. The product's own
wiring (`compareAgainstCounterparts`, `collectPinDesyncFindings` — src/review.ts) had grown three
W7 capabilities the harness never ran: `compareDeclaredContracts` (positional pairing inside a
declared pair), `findUncoveredUnionMembers` (union coverage), and `detectPinDesync`. All three
cross-artifact fixtures therefore MISSED here while the shipped reviewer would have published every
one — the exact "measure the product, not a copy" failure class W7 itself was built to close, one
layer down. Fixed by carrying the product's full chain in both `computeGateFindings` copies
(run.mjs and gate.test.mjs), with the firing side now pinned by three flipped tests; two fixture
`defect.file` anchors moved to the CHANGED file because a review comment can only anchor inside
the pull request's own diff (the product's own anchoring rule), and the pin-desync case's anchor
list gained the deterministic gate's own phrasing ("left behind", "drift\*") under the grader's
stated doctrine — any one of several ways a reviewer might name the defect.

The Keiko#2977 live miss (`pinned-reference-duplicate-desync`) — the case this epic exists to
close — is found by the shipped gate and now measured as found.

## Verdict

Promotion conditions met: severe recall holds across main + second opinion, precision 1.0,
publishable 1.0, no rule change involved (rule digest unchanged from the shipped economy rule's
lineage). v0.13.0 is qualified on the exact tree the release branch will carry.
