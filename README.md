# quality-cards

Generated data branch — do not edit by hand. The `quality-cards` workflow on `dev` renders each
repository's review-record card (`widget/scripts/render-card.mjs`, same renderer as the
quality.keiko.dev service) on a schedule and commits the SVGs here. READMEs embed the raw URLs;
when quality.keiko.dev is deployed, they swap to the live endpoint and this branch retires.
