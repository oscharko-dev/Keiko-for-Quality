# Qualification — the live-audit wave (2026-08-08, post-v0.20.0 fixes)

Measures the four fixes distilled from the first twelve live hours of v0.20.0 on the consumer
(audit: 5 closed PRs, 23 CI runs, every finding re-verified against its diff): companion hunks
in the single-shot prompt plus the companion group as the per-file cache context, the sanitizer
pre-check with one repair call, the wide-drift dedup band plus the summary run trail, and the
second focused pass for heavy files. Cases digest moves (40 cases, `clean-version-bump-twin`
added); rule digest unchanged.

## Scoreboard, against both prior single-shot waves

|                               | wave 1 (v0.20.0) | wave 2 (v0.20.0) | **this wave** |
| ----------------------------- | ---------------- | ---------------- | ------------- |
| recall                        | 28/29            | 27/29            | **29/29**     |
| classified                    | 27/28            | 27/27            | **29/29**     |
| precision (clean left silent) | 9/9 measured     | 9/9 measured     | 9/10 measured |
| publishable                   | 39/39            | 39/39            | **40/40**     |
| noise                         | 3                | 3                | 3             |
| total tokens                  | 289,525          | 298,136          | 308,769       |
| tokens per severe hit         | 10,723           | 11,467           | 11,027        |

First wave of any mode, agentic or single-shot, to find every seeded defect — including both
long-standing rotators (`workflow-head-checkout`, `cleared-list-omitted-from-update`) that were
dry in every main run this week. One wave is one wave; the rotator list stays.

## The new pin, measured honestly twice

`clean-version-bump-twin` (manifest and version constant moving to the same value in one diff —
the fourteen-times-repeated false-positive class of the live day) passed SILENT at 5,033 tokens
with the manifest reaching the model as a companion hunk. The first draft of the case passed at
0 tokens — neither file was dispatchable under the corpus profile, a pin that measured nothing —
and was rebuilt so the code side dispatches while the manifest, exactly as live, arrives only as
a companion. The 0-token trap is recorded here so no future clean case gets to pass by absence.

## Costs and open lines

- Second-pass surcharge is invisible at corpus scale (7,719 tokens/case vs 7,424 in wave 2):
  corpus fixtures rarely cross the 150-changed-line gate. Its live effect lands on heavy files
  only, by design.
- `clean-error-context-added` produced 1 unwanted finding this wave (green in both prior waves) —
  the noise band rotating, on the watch list next to the steady noise-3 line.
- `budget-starved-clean-neighbours` stays unmeasured by the harness's own ruling (third
  consecutive wave); its allotment needs recalibration to single-shot prices.
- Sanitization rejects: 0 across the wave; the repair path's unit coverage carries the contract.

## Spend

308,769 (wave) + 5,033 (twin isolation) = 313,802 tokens. Standing development authorization.

---
