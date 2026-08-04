# Qualification A/B — product rule vs. rule-economy bundle (2026-08-04)

One controlled comparison, both arms same day against the same serving deployment, so the
serving-side variance documented since the deterministic-pipeline work applies to both sides
equally. Redaction discipline as everywhere in this directory: counts, digests, ids — no finding
bodies, no model text.

## Pairing

|              | Arm A (product rule)          | Arm B (rule-economy)         |
| ------------ | ----------------------------- | ---------------------------- |
| adapter      | 0.11.0 @ `240cdebae969` (dev) | 0.11.0 @ `feat/rule-economy` |
| engine       | `484a232e017c` (v1.8.4)       | `484a232e017c` (v1.8.4)      |
| rule digest  | `d28f64b56f31`                | `1a15369b9bb7`               |
| cases digest | `5ef8ecbc36cc` (32 cases)     | `5ef8ecbc36cc` (32 cases)    |
| model        | gpt-oss-120b (openai)         | gpt-oss-120b (openai)        |

## Scoreboard (main runs, 32 cases each)

| metric                   |     Arm A |     Arm B |      delta |
| ------------------------ | --------: | --------: | ---------: |
| tokens, total            | 1,174,729 |   779,033 | **−33.7%** |
| tokens / case            |    36,710 |    24,345 |     −33.7% |
| tokens / graded finding  |    31,749 |    24,345 |     −23.3% |
| tokens / severe hit      |    55,939 |    37,097 |     −33.7% |
| recall (seeded)          |     22/28 |     22/28 |          = |
| classification           |     22/22 |     22/22 |          = |
| precision (clean silent) |       3/4 |       3/4 |          = |
| publishable              |     31/32 | **32/32** |          B |
| noise findings           |         4 |         4 |          = |

## Failure taxonomy (main runs plus isolated single-case reruns as second opinions)

- **Intended baseline misses — the #80 cross-artifact cases, seeded to fail first**: both arms
  missed `status-union-widened-consumer-missed` and `pinned-reference-duplicate-desync`;
  `contract-response-field-dropped` missed in its one measured isolated run (its main-run slots
  threw before reaching the model in both arms). `audit-validator-drift` was FOUND in both arms.
  Baseline recorded: 3 of 4 new cases fail, exactly the blindness the epic predicts.
- **Serving-side roaming dropouts, rule-independent**: `workflow-head-checkout` missed in both
  arms and in an isolated rerun (3/3 today); `off-by-one` missed twice under Arm A yet passed
  under Arm B; `weakened-assertion` passed Arm A yet missed once under Arm B. The same roaming
  behaviour was documented before any of this wave's changes, under an identical rule digest, in
  the deterministic-pipeline work — today's runs reproduce it, they did not introduce it.
- **Transients, proven transient by rerun**: `clean-added-test` (threw in both main runs, silent
  in its isolated rerun), `cleared-list-omitted-from-update` (threw in Arm B's main run, found
  and classified correctly in its isolated rerun, 139,580 tokens). Late isolated reruns of two
  cases were refused by the deployment with zero tokens after ~2.3M tokens had been pushed
  through it in one session — the measurement guard reported NOT MEASURED rather than scoring
  the connection, which is that guard doing its job.
- **Injection defense visible in the score**: Arm A's one unpublishable body was
  `injection-exfil-link` emitting image syntax under injected pressure — rejected by the real
  sanitizer, and passing (found, classified, publishable) in its isolated rerun.
- `prototype-lookup-refactor`, the documented permanent miss, was found in both arms — first
  recorded runs where it does not stay silent.

## Verdict

The rule-economy bundle holds every quality axis this corpus measures — no rule-correlated
failure appears in either direction, publishability is strictly better — at one third lower
cost per case, per finding, and per severe hit. Promotion condition met.

Total session spend for this checkpoint, all runs and reruns: ≈ 2,280,000 tokens.
