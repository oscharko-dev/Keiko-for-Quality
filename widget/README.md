# quality.keiko.dev — the live README widget

The service behind the card widget in the product README: a Cloudflare Worker that renders one
repository's exact trailing-30-day review record as a self-contained SVG in the Keiko for Quality
design language.

The primary row shows current per-pull-request review records, findings created in the window, and
the share of those PR records whose real settlement is `complete`. The chip is the newest real
settlement. The operational row adds the released chronological-holdout precision, open review
threads, and the exact UTC collection timestamp. Workflow success and thread-resolution percentage
are deliberately absent: neither proves that a review completed or that a finding was correct.

```
GET https://quality.keiko.dev/widget/<owner>/<repo>.svg          # dark (default)
GET https://quality.keiko.dev/widget/<owner>/<repo>.svg?theme=light
```

## Shape

| File                      | Role                                                                     |
| ------------------------- | ------------------------------------------------------------------------ |
| `src/card.ts`             | Pure SVG renderer — the whole visual contract, unit-tested byte-for-byte |
| `src/collect.ts`          | Bounded GitHub API collection; every failure degrades to an em dash      |
| `src/quality-evidence.ts` | Precision from the newest immutable release evidence, fail closed        |
| `src/github-app.ts`       | GitHub App JWT + installation token on WebCrypto, no dependencies        |
| `src/request-budget.ts`   | One shared hard 50-request cap across App auth and collection            |
| `src/worker.ts`           | Edge adapter: routing, owner allowlist, edge caching (`s-maxage=600`)    |
| `src/cf.d.ts`             | The two Cloudflare-specific type declarations, by hand                   |

No runtime dependencies. `npm run typecheck:widget` and `npm run test:widget` run in the
repository's verify chain; the Worker toolchain is only needed to deploy.

Honesty rules carried over from the product: a metric the API could not provide renders as an em
dash, never as a fabricated zero. Candidate-search dates are coarse only; summary event timestamps
and finding-comment timestamps are filtered locally against the exact millisecond cutoff. Completion
counts one maintained summary per PR — the latest record for that PR — and reads `complete`,
`incomplete`, or `abandoned` from the reviewer's own marker-bound summary. It is not inferred from an
Actions conclusion. Both the current chip format and every historical text format still present in
the 30-day population are parsed; an unknown bot-summary format withholds the settlement metric.

The precision cell is also intentionally narrow: it is the chronological holdout from the newest
published release's historical replay, currently a Keiko-based corroborated population. It is
labelled `HOLDOUT PREC` and versioned on the card; it is not presented as universal accuracy on the
repository shown. The loader resolves the newest GitHub Release, its immutable tag tree, and exactly
one version-bound evidence blob, then recomputes precision from the confusion matrix. Candidate or
moving-`dev` evidence is never eligible.

Review-thread and issue-comment totals and node ids are reconciled across every GraphQL page before
any metric is admitted. GitHub App authentication, collection, and released-evidence lookup share
one hard 50-request budget in the Worker; if the population cannot be completed, the affected metric
is withheld rather than reported as a floor. The pull request's run summary stays the authority for
one review — the card is an aggregate monitor, not a second verdict.

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
