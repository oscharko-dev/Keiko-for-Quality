# quality.keiko.dev — the live README widget

The service behind the card widget in the product README: a Cloudflare Worker that renders one
repository's review record — runs over thirty days, findings, the acted-on share, the latest
outcome — as a self-contained SVG in the Keiko for Quality design language.

```
GET https://quality.keiko.dev/widget/<owner>/<repo>.svg          # dark (default)
GET https://quality.keiko.dev/widget/<owner>/<repo>.svg?theme=light
```

## Shape

| File                | Role                                                                     |
| ------------------- | ------------------------------------------------------------------------ |
| `src/card.ts`       | Pure SVG renderer — the whole visual contract, unit-tested byte-for-byte |
| `src/collect.ts`    | Bounded GitHub API collection; every failure degrades to an em dash      |
| `src/github-app.ts` | GitHub App JWT + installation token on WebCrypto, no dependencies        |
| `src/worker.ts`     | Edge adapter: routing, owner allowlist, edge caching (`s-maxage=600`)    |
| `src/cf.d.ts`       | The two Cloudflare-specific type declarations, by hand                   |

No runtime dependencies. `npm run typecheck:widget` and `npm run test:widget` run in the
repository's verify chain; the Worker toolchain is only needed to deploy.

Honesty rules carried over from the product: a metric the API could not provide renders as an
em dash, never as a fabricated zero; a red run renders `INCOMPLETE`; the run summary on the pull
request stays the authority — the card is a pointer, not a second source of truth.

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

After go-live, un-comment the widget lines in this repository's `README.md` and in the Keiko
README — the `<img>` tags are already in place, commented, pointing at this service.

## Abuse posture

The service holds a read credential and answers on a public URL, so it only answers for owners
in `KQ_ALLOWED_OWNERS` (404 otherwise), validates owner/repo names against GitHub's grammar,
serves every card from the edge cache for ten minutes, and never echoes request content — the
only dynamic text in the SVG is the owner/repo pair, escaped.
