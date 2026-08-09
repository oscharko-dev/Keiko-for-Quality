# What the precision instrument can and cannot see — measured 2026-08-09, before building on it

The v0.22.0 wave proposes to suppress findings against rules learned from past refutations. Before
writing that, four questions were asked of the instruments that would have to police it. Three
answers changed the design. One suspicion was checked and came back clean, and that is recorded
here too, because a negative result nobody writes down gets re-litigated.

## 1. The precision gate is blind to over-suppression, and over-suppression improves its score

`precision-gate-lib.mjs`:

```js
export function actionableRate(totals) {
  const graded = totals.fixed + totals.refuted;
  return graded === 0 ? undefined : totals.fixed / graded;
}
```

The population is **published** findings that a reader answered. A finding that a learned rule
suppresses is never published, never answered, never graded — it leaves the denominator entirely.
Suppressing a _true_ positive therefore moves the rate **up**.

This is not a defect in the gate; it measures what it says it measures. It is a statement about
what may be built on top of it: **the precision gate must never be the only detector for a
suppression mechanism**, because the mechanism's worst failure is invisible to it and rewarded by
it. Whatever suppresses needs a detector that counts what was removed, not what survived.

## 2. `similarity.ts` cannot represent a learned rule — polarity is erased before matching

The wave's plan and one design pass both specified reusing `recurrenceBodiesMatch`
(`src/publish/similarity.ts`, 0.70 overlap / 8 shared tokens) to match a candidate finding against a
recorded claim. Measured against the real tokenizer — `STOPWORDS` contains `"not"`, and the
`length >= 3` filter drops `"no"`:

| Recorded claim                                         | Candidate finding                                 | Tokens                                  | Overlap  |
| ------------------------------------------------------ | ------------------------------------------------- | --------------------------------------- | -------- |
| `there is no guard clearing the pending-read flag`     | `there is a guard clearing the pending-read flag` | **identical sets**                      | **1.00** |
| `the request handler does not validate the auth token` | `the request handler validates the auth token`    | differ only by `validate`/`validates`   | 0.80     |
| `the parser does not normalize the incoming path`      | `the parser normalizes the incoming path`         | differ only by `normalize`/`normalizes` | 0.75     |

The first row is the finding: two claims with **opposite meaning** score a perfect 1.00. Rows two
and three score below 1.00 only because there is no stemmer and the verb happens to carry an `s` —
morphological luck, not a safeguard.

This is correct behaviour for the job that function was written for. Deduplication asks "are these
two comments the same complaint", and two paraphrases of one finding genuinely do differ in polarity
words alone. A learned rule asks the opposite question — its entire content is the negation — and
every phrase that carries it (`does not`, `no guard`, `never clears`; see `CLAIM_PHRASES` in
`src/engine/verify-claims.ts`) is a phrase this tokenizer deletes.

Two further measurements, from the same run:

- **The score component carries no information here.** `tokenOverlap` divides by the _smaller_ set,
  which for a rule-versus-finding comparison is always the rule. A 6-token rule scored **1.00**
  against a deliberately unrelated 16-token finding that merely reused its domain vocabulary. Only
  the raw shared-token floor (`MIN_RECURRENCE_SHARED_TOKENS = 8`) prevented a false fire — so the
  bar in practice is "do these share 8+ content words", and the calibrated 0.70 threshold does no
  work at all.
- **Precise rules fall in a dead band.** `Do not claim missing validation for request headers in
the routes module.` yields 7 content tokens and therefore can _never_ reach 8 shared — it is
  permanently inert. Rules long enough to fire are long enough to be vague.

**Consequence for W3:** rule matching does not go through `similarity.ts`. The replacement is a
deterministic triple that preserves polarity by construction, because the vocabulary _is_ the
polarity: a path glob (dialect and bounds already in `src/config/profile.ts`), a claim kind from the
closed `CLAIM_VERBS` / `CLAIM_PHRASES` sets, and one backticked identifier via the existing
`BACKTICKED` regex. A rule that cannot be written as `(path, claim-kind, identifier)` is a rule we
do not understand well enough to enforce silently.

Reproduce: `scratchpad/polarity-proof.mjs` parses `STOPWORDS` out of the source file rather than
restating it, so it cannot drift from the function it is testing.

## 3. The automated detectors cover almost none of the surface a rule would act on

| Detector               | Cases                       | Files it could detect over-suppression on                                                                                                                            |
| ---------------------- | --------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `corpus/run.mjs`       | 44 (12 with `defect: null`) | **none** — every case path is synthetic (`src/auth.ts`, `scripts/tip.mjs`, `.github/workflows/review.yml`). A rule keyed on a consumer path cannot fire here at all. |
| `corpus/seed-gate.mjs` | 5 (2 `required: true`)      | **2** — both required cases seed `connectorAuthorization.ts`; `connectorRoutes.ts` appears only inside the advisory multi-push case.                                 |

The seed gate is genuinely sensitive _within_ those two files: the v0.21.2 evidence records exactly
one finding in the seeded file on every passing case, so a rule that ate it would flip the gate red.
That sensitivity stops at the file boundary, and the consumer's reviewable tree is thousands of
files wide.

This is the measured reason the wave's order puts **W6 (widen the measuring stick) before W3
(activate suppression)**, rather than the intuition that motivated it. Two files is not a detector
for a repository-wide mechanism.

One prerequisite falls out of it: `LocalReviewReport` (`src/review.ts`) carries **no suppression
counts of any kind**, and the seed gate reads `report.findings` only. So even on those two files the
gate cannot distinguish "the model found nothing" from "a rule removed it" — it goes red without a
cause. A suppression count in the local report is a precondition for W3, not a nicety.

## 4. Our own watchers poisoned data — but not the baseline. Checked, not assumed.

Forty-one watcher scripts in this session's scratchpad ended each poll by calling
`resolveReviewThread` on every open reviewer thread, with no reply. `gradePullRequest` grades a
finding by its first non-reviewer reply, so a silently resolved thread lands in `unanswered` and is
dropped from the rate. That is selection bias on the very number the wave exists to move, and it
raised a real possibility: **that 21.0% is an artifact of our own tooling.**

It is not. The watchers ran on Keiko PRs **3018, 3027, 3029, 3030, 3035, 3049**. The baseline graded
**3037, 3040, 3041, 3031, 3032, 3028, 3003, 3005, 3006**. The two sets are disjoint, so no baseline
thread was touched. The 21.0% stands as the before-value.

The damage is forward-looking and real in three ways, which is why the tooling changed first:

1. **Future windows.** PR 3049 was watched on 2026-08-09 under the v0.21.2 pin — precisely the
   after-window that tests whether the verification wave worked.
2. **The harvest.** A silent resolve destroys the refutation text, which is the only artifact that
   says _why_ a finding was wrong. W1 and W2 have no input without it.
3. **Duplicates we caused ourselves.** A resolved thread is invisible to
   `findsSimilarOpenConversation` (it requires `!thread.resolved`) and, lacking a substantive reply,
   also to `findsDispositionedConversation`. Every silently resolved finding became re-publishable on
   the next push — the watcher manufactured the duplicates it was clearing.

Fixed by retiring all 41 and replacing them with one `scratchpad/watch-pr.sh` that reports threads
and their replies and resolves nothing, and by writing the rule into the consumer's `AGENTS.md`: a
reviewer finding thread is resolved by whoever answers it, carrying either a fix reference or an
evidenced refutation.

## What this changes in the v0.22.0 plan

| Plan item                                      | Status after measurement                                                                           |
| ---------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| W3 matching via `recurrenceBodiesMatch` 0.70/8 | **Replaced** — polarity-blind (§2). Deterministic `(path, claim-kind, identifier)` instead.        |
| W6 before W3                                   | **Confirmed, with a number** — 2 files of coverage, not an intuition (§3).                         |
| Suppression counted in the run summary         | **Confirmed as necessary, and now also a precondition**: `LocalReviewReport` needs one first (§3). |
| 21.0% as the before-value                      | **Confirmed** — disjoint from the watcher's pull requests (§4).                                    |
| The precision gate as W3's detector            | **Rejected** — structurally blind to over-suppression and rewarded by it (§1).                     |
