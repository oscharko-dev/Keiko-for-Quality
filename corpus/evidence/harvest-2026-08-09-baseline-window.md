# The harvest's first run — the 2026-08-08 window, all three bots, git-corroborated

`npm run corpus:harvest -- --repo oscharko-dev/Keiko --prs 3037,3040,3041,3031,3032,3028,3003,3005,3006`

The same nine pull requests `precision-2026-08-08-baseline.md` graded, read a second way: every
finding of every bot, every reply, and what the repository's own commits did to the cited region
afterwards. 279 findings.

## It reproduces the precision gate exactly, which is the first thing worth reporting

|                     | precision gate | harvest   |
| ------------------- | -------------- | --------- |
| findings published  | 92             | 92        |
| fixed               | 17             | 17        |
| refuted             | 64             | 64        |
| unanswered          | 11             | 11        |
| **actionable rate** | **21.0%**      | **21.0%** |

Two independent implementations, reading the same threads through different code, agree to the
finding. The 21.0% before-value is not an artifact of one classifier.

## What the gate cannot see: the same window, per bot, with git as a second witness

`fixed_confirmed` means the reader said they fixed it **and** a later commit touched the cited
region. `refuted_confirmed` means the reader argued it was wrong **and** no later commit touched it.
Where prose and behaviour disagree, the finding lands in its own label instead of the pile.

| Bot                   | published | answered | fixed ✓ | refuted ✓ | prose+git agree | **corroborated hit rate** |
| --------------------- | --------- | -------- | ------- | --------- | --------------- | ------------------------- |
| **Keiko for Quality** | 92        | 88%      | 17      | 49        | 66              | **25.8%**                 |
| Codex                 | 140       | 85%      | 93      | 4         | 97              | **95.9%**                 |
| CodeRabbit            | 43        | 51%      | 18      | 2         | 20              | **90.0%**                 |

This is the wave's target restated with a sharper instrument than the arena baseline's 67% / 92%,
and on the _current_ release rather than v0.11.0. On a window where our findings were answered at a
higher rate than either competitor's, we were right about one finding in four, and Codex was right
about nineteen in twenty.

**One caveat, stated because it cuts our way and should not be leaned on.** Our findings block the
merge through conversation resolution, so an agent must answer them; the other bots' findings carry
no such obligation. That could enrich our graded population with arguments. It does not explain the
gap: Codex was answered on 85% of its findings against our 88%, and still landed at 95.9%.
CodeRabbit's 51% answer rate does make its column the weakest of the three.

## The guard that this harvest exists for

**15 of our 64 refutations (23.4%) are `refuted_contradicted`** — the reply argued the finding was
wrong, and a later commit touched exactly that region anyway.

This is _not_ a claim that those 15 refutations were wrong. `classifyActedUpon` fires on any later
commit within a 3-line tolerance, and one of the 15 sits in
`packages/keiko-ui/src/lib/i18n-messages.de.ts` — a translation catalogue that changes constantly
for reasons that have nothing to do with the argument. The label is a **conservative filter**, not a
verdict: it removes candidates we cannot be sure about, and keeps the ones where prose and
behaviour agree.

The effect is the whole point. Of 64 refutations, **49 are distillable** into learned rules and 15
are not — and without the git side, all 64 would have looked equally solid. A rule minted from a
contradicted refutation would silence a real defect forever, and nothing downstream would ever say
so.

## Recall gaps: 117, and they are not all real

Findings another bot made where we said nothing in an overlapping window on that path, **filtered to
the ones a later commit actually touched**: 82 from Codex, 35 from CodeRabbit.

The filter is load-bearing. `clusterAcrossBots` links findings on path plus overlapping window with
**no similarity requirement** — unlike `linkWithinBotDuplicates` directly above it, which requires
Jaccard similarity too, for the reason its own comment records (three unrelated CodeRabbit findings
at overlapping lines in one hunk). A file-level finding overlaps everything on its path. So an
unfiltered gap set is "somebody remarked near a place we didn't", which includes every style
nitpick and every finding this product deliberately suppresses as low-consequence. `acted_upon` is
the only anchor that separates a missed defect from a difference of taste: somebody read the remark
and changed that code.

117 is still an upper bound, not a work list. Each one has to be read before it becomes a seed case.

## Cost and posture

Reads only — no model call, no token spend, nothing written to the consumer. The commit timeline is
the expensive half (one REST call per commit per pull request) and is on by default, because
without it no refutation can be corroborated; `--no-commits` gives a cheap survey whose labels say
plainly that nothing in it is confirmed.

**The document itself is never committed.** It carries verbatim comment text written by humans and
by third-party bots on a public repository — exactly what the arena evidence redacts. `harvest.mjs`
refuses an `--out` path inside this repository rather than trusting the operator to remember. Only
distilled rules, reviewed as a pull request in the consumer, ever become durable.
