# False-positive analysis — `clean-reset-modules-is-load-bearing` (2026-08-06)

Follow-up to the open calibration question `qualification-2026-08-06-v0.18.0.md` recorded: three
false positives in three observations on the v0.18.0 tree, against a silent v0.17.0-tree control
and a 2-clean / 1-FP v0.15.0 precedent. This document answers the question that evidence left
open — is the CASE ambiguous, or does the RULE invite the class — with isolated observations,
and records the recalibration those observations forced.

Redaction discipline as everywhere in this directory: counts, digests, ids, token totals, and the
harness's own redacted first line (78 characters of a finding's imperative first sentence, as the
run log prints it). No finding bodies, no model prose beyond that line. Pattern classifications
below were made against the run reports and are stated as descriptions, never quotations.

**Everything this document motivates — the case recalibration AND the rule-text addition — is
qualified configuration. The cases digest and the rule digest both move. NONE of it may ship on
the strength of this document: it must ride the next full corpus qualification (v0.19.0), never a
hotfix, never a point release.** The per-case validation runs below are engineering evidence that
the recalibration addresses what was observed; they are not, and cannot be, a qualification.

## Binding, diagnosis phase

Identical to the v0.18.0 wave, byte for byte — the same open question, re-observed:

|               | Diagnosis runs r1–r6     |
| ------------- | ------------------------ |
| adapter tree  | `410dc2a` (dev, v0.18.0) |
| engine        | `484a232e017c` (v1.8.4)  |
| rule digest   | `4fd942dbdb8d`           |
| cases digest  | `8e9946d6ecc7`           |
| scorer digest | `acd8bfc4ef45`           |
| model         | gpt-oss-120b (openai)    |

## Observations — diagnosis on the unchanged configuration

Six isolated runs (`node corpus/run.mjs --only clean-reset-modules-is-load-bearing`):

| run | outcome     | tokens | claim shape (see below)                                                    |
| --- | ----------- | ------ | -------------------------------------------------------------------------- |
| r1  | PASS silent | 12,802 | —                                                                          |
| r2  | PASS silent | 12,750 | —                                                                          |
| r3  | PASS silent | 6,451  | —                                                                          |
| r4  | PASS silent | 6,511  | —                                                                          |
| r5  | **1 FP**    | 18,860 | wrong-mechanics isolation claim, `test`/`high`, anchored on the added test |
| r6  | PASS silent | 18,576 | —                                                                          |

r5's harness-redacted first line:

```
high/test  src/cache.test.ts  Ensure test isolation: ES modules are cached, so `await import("./cache.js")`
```

Session FP rate on the unchanged configuration: **1/6**. Pooled with the wave's observations at
the identical binding (3 FP in 3 runs, plus the 1 silent control): **4 FP in 10 observations**.
The morning drew 3/3 and this afternoon drew 1/6 from the same bytes — the serving-side variance
the v0.15.0 wave named is not i.i.d. across hours, and single-day streaks in either direction
overstate what the configuration does.

## What the false positives claim

Four FP bodies were directly observed in this session (one on the unchanged configuration, three
during staged validation below). Classified structurally:

- **Wrong-mechanics isolation claim** (r5, v3, v4 — three of four): category `test`, severity
  `high`, anchored inside the added test's hunk (head lines 14–17). Each claims module caching
  defeats per-case isolation of the dynamic import, and each proposes adding a reset. None of the
  three bodies mentions `beforeEach` or `vi.resetModules` at all — each reasons as if the file
  had no setup — and each repair calls something that does not exist: a module export the fixture
  never had (`clearCache` in r5, `resetCache` in v3, both hedged as optional or commented as
  "ensure"), or the wrong framework's API (`jest.resetModules()` in a vitest suite, v4).
- **Grounded name-versus-assertion gap** (v2 — one of four): category `test`, severity `high`,
  same anchor. Claims the added test does not verify what its name claims. This one was CORRECT
  — see layer two below — and is scored here as a corpus defect the diagnosis surfaced, not as a
  model failure.

The historical published shape the case's own comment records — "remove the redundant
`vi.resetModules()`" — is the same guard misjudged in the opposite direction: the observed class
never saw the reset; the published one saw it and called it removable.

## Verdict: (a), with a falsified (b) hypothesis and a narrow (b) residual

**The severity-ladder hypothesis is falsified.** The briefed (b) candidate — a "removed or
loosened" pattern-match riding the ladder's "a bound, timeout, limit, pin, or assertion removed
or loosened" — does not appear in any observed body: no FP claims removal or loosening, none uses
that vocabulary, and the diff is purely additive. The rule's severity ladder is not the
invitation.

**The case carried two real artifacts (verdict a), each with its own failing evidence:**

1. **The module under test was never committed.** The fixture referenced `./cache.js` and the
   repository did not contain it, so every claim about what the reset does to module state was
   ungroundable — r5's repair inventing an export for a module it could not read is the direct
   signature. This is the same incoherent-repository condition `clean-added-test` measured on the
   v0.15.0 wave (2/8 passing before its module was committed, 6/6 after), and
   `MODULE_OMITTED_ON_PURPOSE` (corpus/case-coherence.test.mjs) always said an entry leaves that
   list exactly this way: with failing evidence.
2. **The added test did not test what its name claims.** Its old assertion — `lookup("b")` twice
   under `toBe` — could never fail under state bleeding, with or without the reset. Once layer
   one made the module readable, the model grounded that gap (v2) — a defensible finding, and a
   clean case must not contain one.

**One mechanism sits past the fixture's reach, and one legitimate fixture move remains for it:**
the `beforeEach` reset lives at the top of the file, outside the added hunk's diff context, and
every wrong-mechanics FP reasons without mentioning it — the draws where the model judges the
hunk without opening the file. The added test now states its own premise in an author comment
inside the hunk, which is what a real author writes when a reviewer misreads isolation, and which
moves the case from measuring tool-use propensity (pure serving variance) to measuring the
judgement the case is named for: respecting a stated, correct isolation mechanism.

**The narrow (b) residual:** nothing in the rule required reading a suite's own setup before an
isolation claim, and nothing forbade a repair calling API that does not exist — the two failures
all three wrong-mechanics bodies share. One bullet added to "Look before you claim"
(src/engine/rule-file.ts) targets exactly that pair, pinned by a row in
src/engine/rule-file.test.ts. It is an additive claim-hygiene directive in an existing section;
it changes the prompt every case sees, which is precisely why it cannot ship outside a wave.

## The recalibration, and the staged validation that shaped it

| run | configuration under test                     | cases digest   | rule digest    | outcome     | tokens |
| --- | -------------------------------------------- | -------------- | -------------- | ----------- | ------ |
| v1  | layer 1 (module as context)                  | `8e8e6e72ec61` | `4fd942dbdb8d` | PASS silent | 12,304 |
| v2  | layer 1                                      | `8e8e6e72ec61` | `4fd942dbdb8d` | **1 FP**    | 23,378 |
| v3  | layers 1+2 (isolation assertion re-cut)      | `5613f3dbddd0` | `4fd942dbdb8d` | **1 FP**    | 44,516 |
| v4  | layers 1+2 + rule bullet                     | `5613f3dbddd0` | `5e302d88128a` | **1 FP**    | 17,900 |
| v5  | layers 1+2+3 (in-hunk premise) + rule bullet | `437536225fb1` | `5e302d88128a` | PASS silent | 39,076 |
| v6  | final, same as v5                            | `437536225fb1` | `5e302d88128a` | PASS silent | 71,498 |
| v7  | final, same as v5                            | `437536225fb1` | `5e302d88128a` | PASS silent | 65,049 |

Harness-redacted first lines of the three validation FPs:

```
high/test  src/cache.test.ts  The added test does not verify that memoized values are cleared between test c
high/test  src/cache.test.ts  The test assumes the cache module is re-initialized for each test case, but ES
high/test  src/cache.test.ts  Reset module cache before importing cache to ensure test isolation.
```

The staged layers, all in corpus/cases.mjs and pinned by corpus/case-coherence.test.mjs:

1. `src/cache.ts` committed as unchanged context (base === head): a module-scope memo `Map`,
   `lookup`, and `entryCount`. The id leaves `MODULE_OMITTED_ON_PURPOSE`; a pin test mirrors
   `clean-added-test`'s (context, not diff; must memoize at module scope; must export what the
   added assertion calls).
2. The added test asserts the property its name claims: `entryCount()` is 0 on a fresh module —
   it would be 1 if the previous case's instance leaked through — and 1 after one lookup. The
   reset is now mechanically load-bearing: remove it and the suite fails.
3. An author comment inside the added hunk states the premise the out-of-hunk `beforeEach`
   provides.

And the rule-text addition (src/engine/rule-file.ts, "Look before you claim"): before claiming a
test's reset/isolation/fresh-state setup fails, read the suite's own setup; a documented
framework facility doing what it documents is the default, not a finding; a proposed fix may only
call what exists.

## What the validation sample does and does not show

Three silent draws on the final configuration (v5–v7) show the recalibration addresses the
observed shapes; three draws prove nothing about a rate — the wave-level qualification does.
Stated rather than hidden: silence got more expensive on this case (39k–71k tokens against
6.4k–18.6k for pre-change silent draws) — the model now verifies where it used to conclude, and
some draws verify at length. Whether that cost holds across the other 38 cases, and whether the
rule bullet moves any other case in either direction, is exactly what the v0.19.0 wave must
measure before any of this ships.

## Spend

Thirteen isolated runs, 349,671 tokens total (diagnosis r1–r6: 75,950; validation v1–v7:
273,721), plus zero-token harness smoke runs. All against the standing development authorization.
