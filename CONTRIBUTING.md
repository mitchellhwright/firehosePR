# Contributing

Use Node 24 or newer. Run `npm ci`, then `npm run check`.

Keep changes to reusable code in `src/` and `ci/src/`. Add regression tests for incorrect omission of work, stale evidence, and trust-boundary failures. Rebuild `dist/`; it is committed so a GitHub-tag dependency can be installed before an npm registry release.

The `reference/` snapshot is historical, sanitized source. Its product-specific fixtures and external infrastructure are not included. Do not treat its historical tests as passing package tests or enable its workflows without a consumer-specific review.

Do not weaken coverage or required checks to improve timings. Report measured before/after workload and environment details, distinguishing executed tests from reused evidence. Local tests, remote CI, deployment, and end-user acceptance are separate results.
