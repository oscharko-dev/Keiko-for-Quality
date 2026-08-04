# Consuming the `keiko-cli` release asset — the pin format

Every release from v0.13.0 onward publishes two assets, attached automatically when the GitHub
release is created (`.github/workflows/release-assets.yml`):

- `keiko-cli.js` — the self-contained CLI bundle, byte-identical to the release tree's committed
  `dist/cli.js`. Runs standalone under Node ≥ 24: no hooks, no `node_modules`, no tsconfig.
- `sha256sum.txt` — one line in GNU coreutils format: `<64-hex-digest>  keiko-cli.js`.

A consumer (the VS Code and IntelliJ extension epics) pins the CLI exactly the way this repository
pins its review engine — digest first, fail closed:

1. Record, at integration time, the release **tag** and the asset's **SHA-256 digest** (from
   `sha256sum.txt`, or independently: `shasum -a 256 keiko-cli.js`). The digest — not the tag — is
   the trust anchor: tags are mutable references, bytes are not.
2. At acquisition time, download `keiko-cli.js` from
   `https://github.com/oscharko-dev/Keiko-for-Quality/releases/download/<tag>/keiko-cli.js`,
   compute SHA-256 over the received bytes, and compare against the pinned digest.
3. On any mismatch, **discard the download and fail closed** — never execute, never retry against
   a different tag, never fall back to an unpinned copy. A mismatch means the bytes are not the
   reviewed bytes; nothing downstream can repair that.
4. Execute as `node keiko-cli.js …`. The process contract (flags, environment, exit codes 0–5,
   `--format json|sarif`) is documented in the README's "Local runs" section and
   `docs/local-report-schema.md`; exit codes and the report schema are additive-stable within a
   release line.

Verification needs nothing beyond a SHA-256 implementation and this file — reading this
repository's source is not required (issue #98's acceptance bar).
