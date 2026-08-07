# Qualification — tool-round ceiling (2026-08-06, post-v0.19.2)

Measures the change that raised the engine's per-file tool-round ceiling from its embedded default
of 30 to 60 (`MAX_TOOL_ROUNDS_PER_FILE`), together with the per-file price that had to follow it
(`allottedPerFile`). Binding is byte-identical to the v0.19.2 wave — rule, cases and scorer digests
unchanged — so the two are directly comparable.

## Scoreboard, against the v0.19.2 wave

|                               | v0.19.2 (30 rounds) | this wave (60 rounds)              |
| ----------------------------- | ------------------- | ---------------------------------- |
| recall                        | 27/29               | **28/29**                          |
| severe hits                   | 26                  | **27**                             |
| precision (clean left silent) | 10/10               | 10/10                              |
| publishable                   | 39/39               | 39/39                              |
| classified                    | 27/27               | 26/28 (2 off by one severity step) |
| noise                         | 1                   | 2                                  |
| **total tokens**              | 2,207,077           | **1,605,843**                      |
| tokens per severe hit         | 84,888              | **59,476**                         |

## Allowing more rounds made the wave CHEAPER, and that is the mechanism working

The result reads backwards until the failure it removes is priced. A file that exhausts thirty
rounds pays for all thirty and returns nothing usable — the run then settles a coverage gap, and
under the targeted resume it pays again for a retry. The same file finishing at forty rounds costs
less than its own failure plus that retry. Recall rose and spend fell by 27% for the same reason,
not for two different ones.

## The cost side, stated rather than buried

Classification lost ground: 26 of 28 findings carried the expected category and severity, against
27 of 27 before, with both misses one severity step away. Noise rose from one finding to two. Both
are soft metrics — a severity step, not a wrong file — and neither is in the class of a miss. They
are recorded here because a wave that improved three headline numbers is exactly when a regression
in a fourth is easiest to not mention.

## Per failure

One case failed: `workflow-head-checkout`, MISSED — the known rotator, dry again after passing
isolated in the v0.19.2 wave. It stays on the rotator list. `unevidenced-claim`, the other
long-standing rotator, passed in this main run without needing an isolated opinion.

## Spend

1,605,843 tokens, 41,175 per case. Standing development authorization.

---
