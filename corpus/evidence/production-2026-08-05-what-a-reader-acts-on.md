# What a reader acts on — production, 2026-08-05

The first measurement of this reviewer against a competitor on the same pull requests, using the
consumer's own outcome as the scoreboard. Redaction discipline as everywhere in this directory:
counts, rates, ids — no finding bodies, no model text.

## Why this exists

Every number this project had before today came from a 39-case synthetic corpus. That corpus
reported 4/4 precision while an external assessment of one real pull request found 18%. The gap was
never explained; it was measured around. This is the measurement that explains it.

## What was collected

Repo-wide GitHub API sweep over `oscharko-dev/Keiko` — 1,685 pull requests, 4,956 inline review
comments, 4,477 pull-request-level comments, 15 bot authors. No model tokens: all of it is public
API data.

Eight review bots have run on this repository. Their reach, over their own active windows:

| bot                     | comments/PR | PRs | window        |
| ----------------------- | ----------: | --: | ------------- |
| **keiko-for-quality**   |    **31.9** |  18 | 02.–04.08.    |
| chatgpt-codex-connector |        13.3 |  27 | 02.–04.08.    |
| coderabbitai            |         9.0 | 115 | 19.07.–04.08. |
| qodo-code-review        |         3.9 | 149 | 16.–31.07.    |
| Copilot                 |         3.9 | 138 | 28.05.–03.08. |
| gitar-bot               |         3.1 |  48 | 11.–17.07.    |
| greptile-apps           |         4.5 |   2 | 01.08.        |

## The finding

A review thread that is resolved while its line still stands was closed without the code moving. One
whose line changed was, at minimum, worked on. Over 1,201 threads:

| bot                     | threads | resolved with the line untouched | code changed |
| ----------------------- | ------: | -------------------------------: | -----------: |
| **keiko-for-quality**   |     575 |                          **74%** |      **23%** |
| chatgpt-codex-connector |     358 |                              33% |      **64%** |
| coderabbitai            |     230 |                              56% |      **44%** |

**Three quarters of what this reviewer writes is closed without the code moving**, at nearly three
times the comment volume of the bot it is measured against.

The obvious alternative reading — that this bot simply comments later, on code already settled — was
checked against the timestamps and does not hold: it comments EARLIER than the competitor on most
shared pull requests, which if anything gives its comments more opportunity to be overtaken.

## What differs in the prose

One property separates the two and survives being attacked. Over 492 of our findings and 358 of the
competitor's:

|       | states the circumstance the code is wrong in |
| ----- | -------------------------------------------: |
| ours  |                                    **22.0%** |
| Codex |                                    **65.4%** |

Every competitor finding is written _condition → mechanism → consequence → remedy_; ours are written
_remedy → description of the change_. A reader can check whether a stated circumstance can occur. A
reader cannot check "this makes X depend on Y", so they close the thread.

Inside our own history the property decayed: **29.2% of v0.10.0 findings, 10.5% of v0.14.0's.**

### Two measures that were discarded

Recorded because each looked like a result:

- **"Has a reason"**, scored by searching for `because`/`otherwise`/`so that`, reported 53.5% of
  findings as unevidenced — including one arguing from a documented platform behaviour that simply
  never uses the word. A gate on that number would have rejected sound work.
- **"States the consequence"** scored 23.0% against 40.5%, an apparently useful 17.5pp gap. Widening
  it by one causal form real findings plainly use (`, so <clause>`) moved both to 66.9% and 71.8% —
  **4.9pp**. A signal that collapses on a synonym was measuring house style.

The surviving predicate held the same treatment: 41.4pp sentence-anchored, 38.5pp on `When`/`If`
alone, 40.0pp with more keywords, 18.3pp with no anchor at all.

## By category, ours

| category        | share of findings | code changed |
| --------------- | ----------------: | -----------: |
| correctness     |       70.7% (348) |          31% |
| **tests**       |   **21.5% (106)** |      **17%** |
| **security**    |         5.7% (28) |      **14%** |
| documentation   |          1.0% (5) |          80% |
| maintainability |          0.8% (4) |           0% |
| performance     |          0.2% (1) |           0% |

Test findings are a fifth of the output and five in six are closed untouched. Security is worse.
Both are larger, more concrete targets than anything the literature offered — and the one thing the
literature did recommend for us (Kumar et al. 2026: performance defects are missed by every model
regardless of size, so hand them to static analysis) turns out not to apply at all: this reviewer
has published exactly one performance finding.

## What the run telemetry says about cost

41 runs carry a full summary block. 8 reviewed 10 or more files; those 8 account for **90.1% of all
token spend** (12.36M of 13.7M). Thirty small runs together cost 1.36M.

Cache hit rate on large runs: **9.1%** — 321 of 353 files freshly reviewed. One pull request
accumulated **55 workflow runs** and 156 published comments against 92 from four competing bots
combined.

## Honest limits

`isOutdated` is a proxy. A line can change for reasons unrelated to the comment that sat on it. It
applies equally to every bot in the table, so it dilutes the measured gap rather than creating it —
but it is not "the finding was correct", and no number here should be read as if it were.

The 1,201 threads come from 49 pull requests with review threads out of 147 that exist in the
sampled ranges. `isResolved` and `isOutdated` overlap completely (483 of 483), which strongly
suggests repository automation rather than human judgement — which is why the raw 97%-resolved
figure is not used anywhere above, and only the split is.

This reviewer has no history before 2026-08-02. Every trend here is four days long.
