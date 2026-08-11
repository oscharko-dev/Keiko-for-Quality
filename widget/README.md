# quality.keiko.dev — the live README widget

The service behind the card widget in the product README: a Cloudflare Worker that renders one
repository's exact trailing-30-day review record as a self-contained SVG in the Keiko for Quality
design language.

The primary row shows completed review-workflow runs, findings created in the window, and the
current resolved share of those findings. The operational row adds successful-run share, open
review threads, and pull requests with findings. `RUN OK`/`RUN NOT OK` is only the latest GitHub
workflow conclusion; it deliberately makes no claim about the review's own settlement.

```
GET https://quality.keiko.dev/widget/<owner>/<repo>.svg          # dark (default)
GET https://quality.keiko.dev/widget/<owner>/<repo>.svg?theme=light
```

## Shape

| File                    | Role                                                                     |
| ----------------------- | ------------------------------------------------------------------------ |
| `src/card.ts`           | Pure SVG renderer — the whole visual contract, unit-tested byte-for-byte |
| `src/collect.ts`        | Bounded GitHub API collection; every failure degrades to an em dash      |
| `src/github-app.ts`     | GitHub App JWT + installation token on WebCrypto, no dependencies        |
| `src/request-budget.ts` | One shared hard 50-request cap across App auth and collection            |
| `src/worker.ts`         | Edge adapter: routing, owner allowlist, edge caching (`s-maxage=600`)    |
| `src/cf.d.ts`           | The two Cloudflare-specific type declarations, by hand                   |

No runtime dependencies. `npm run typecheck:widget` and `npm run test:widget` run in the
repository's verify chain; the Worker toolchain is only needed to deploy.

Honesty rules carried over from the product: a metric the API could not provide renders as an em
dash, never as a fabricated zero. REST dates only discover candidate pages; full run timestamps and
GraphQL first-comment timestamps are filtered locally against the exact millisecond cutoff. A
resolved thread proves only that the conversation is currently resolved — not that code changed or
that anyone "acted on" it. Likewise, workflow success does not prove a `complete` review settlement.
Review-thread totals and node ids are reconciled across every GraphQL page before any finding metric
is admitted. GitHub App authentication and the two concurrent collection branches share one hard
50-request budget; if a 51st request would be needed, every metric is withheld rather than reported
as a floor. The pull request's run summary stays the authority — the card is a monitor, not a second
verdict.

## Deploying (operator steps)

Two steps need the Cloudflare/GitHub account owner; everything else is in this directory.

1. **Credential** — either a fine-grained PAT (read-only: Actions, Pull requests, Contents on
   the repositories the card serves) as `KQ_GITHUB_TOKEN`, or the existing Keiko for Quality
   GitHub App's id + PKCS#8 private key as `KQ_APP_ID`/`KQ_APP_PRIVATE_KEY`:

   ```bash
   cd widget && npx wrangler secret put KQ_GITHUB_TOKEN
   ```

2. **Domain** — `quality.keiko.dev` as a custom domain on the Worker. If the `keiko.dev` zone
   is in the same Cloudflare account, `npx wrangler deploy` creates the record; otherwise add
   the domain under Workers → Settings → Domains & Routes first.

Then:

```bash
cd widget && npx wrangler deploy
```

After go-live, replace the `quality-cards` raw URLs in this repository's `README.md` and in the
Keiko README with the service URLs above. The static renderer and Worker deliberately share the
same collector and SVG renderer, so delivery does not change metric semantics.

## Abuse posture

The service holds a read credential and answers on a public URL, so it only answers for owners
in `KQ_ALLOWED_OWNERS` (404 otherwise), validates owner/repo names against GitHub's grammar,
serves every card from the edge cache for ten minutes, and never echoes request content — the
only dynamic text in the SVG is the owner/repo pair, escaped.
