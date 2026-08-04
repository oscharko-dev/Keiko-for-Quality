# Local report schema — the wire contract for local runs

The local CLI (`src/cli.ts`, epic #94) emits a machine-readable report in two formats, rendered by
`src/report/`. Both IDE extensions consume this contract; treat it as a wire format, not an
internal type. **Versioning is additive-only**: fields may be added to v1 at any time, and a
consumer must ignore fields it does not know. Renaming, removing, or changing the meaning of an
existing field requires a new schema identifier.

## JSON (`--format json`)

Top-level `schema` is the literal identifier `keiko-for-quality.local-report/v1`.

| Field                             | Type                                        | Meaning                                                                                                                                                                                                         |
| --------------------------------- | ------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `schema`                          | string                                      | `keiko-for-quality.local-report/v1`, always present, check it first                                                                                                                                             |
| `outcome`                         | `"complete" \| "incomplete" \| "abandoned"` | Settlement outcome. **Distinct from finding count** — an `incomplete` run with zero findings is not clean, and every consumer surface must keep the two apart                                                   |
| `reason`                          | string?                                     | Present when `outcome` is not `complete`: the closed-vocabulary reason surface                                                                                                                                  |
| `findings[]`                      | array                                       | What a GitHub run would have published — post-sanitization, post-dedup, post-audit                                                                                                                              |
| `findings[].path`                 | string                                      | Repo-relative, forward slashes                                                                                                                                                                                  |
| `findings[].startLine`, `endLine` | number \| null                              | 1-based, inclusive. **`null` = file-level**: a finding that anchors to the file as a whole (the deterministic contract gates emit these). Both are `null` together or neither                                   |
| `findings[].category`             | string                                      | `bug \| security \| performance \| maintainability \| test \| documentation \| other` — the audit's reclassification where it ran                                                                               |
| `findings[].severity`             | string                                      | `critical \| high \| medium \| low`                                                                                                                                                                             |
| `findings[].body`                 | string                                      | Sanitized Markdown, byte-for-byte what publication would carry                                                                                                                                                  |
| `spend`                           | object                                      | `{ engine, classify, total, allotted }`, tokens. `allotted` is the size-scaled engine stop-loss — real spend can legally exceed it (see the 2026-08-04 evidence); the pair is reported so the gap stays visible |
| `inventory`                       | object                                      | `{ total, reviewable, reviewed }` path counts; `reviewed < reviewable` implies `outcome != "complete"`                                                                                                          |
| `ruleDigest`                      | string                                      | Digest of the exact rule file this run reviewed under — reviews under different digests are not comparable                                                                                                      |
| `engineVersion`                   | string                                      | The digest-pinned engine release                                                                                                                                                                                |

## SARIF (`--format sarif`)

SARIF 2.1.0, one `run`, `tool.driver.name` = `keiko-for-quality`.

- Severity → level: `critical`/`high` → `error`, `medium` → `warning`, `low` → `note`.
- A file-level finding (JSON `startLine: null`) is emitted **without a `region`** — SARIF forbids
  `startLine: 0`, and an artifact location without a region is exactly "the file as a whole".
- A non-`complete` outcome is signaled on two independent channels, because a SARIF consumer
  reading `results: []` must never mistake an incomplete run for a clean one:
  `invocations[0].executionSuccessful` is `false`, and a `toolExecutionNotifications` entry names
  the reason.
- Settlement outcome, reason, spend, inventory, `ruleDigest`, and `engineVersion` are mirrored in
  `runs[0].properties` — SARIF is a full parallel of the JSON report, never a lossy subset.

## Known v1 gaps (planned as additive extensions)

- A dropped-findings count (bodies the sanitizer rejected) is not yet carried by the orchestrator
  report and therefore absent from both formats.
- Richer `identity` (engine digest, model id, protocol), `inputs` (base/head SHAs, profile path),
  and `cache` (hits/misses/appended) blocks are specified by issue #97's full scope and will be
  added as optional fields without a version bump.
