# FirehosePR

Fast pull requests through explicit input ownership, balanced test shards, and careful reuse of build products.

**Package:** `firehosepr` · **CLI:** `fpr` · **Runtime:** Node.js 24 or newer

FirehosePR extracts reusable CI mechanisms from a production application pipeline and supplies a small standalone planner. Unknown changes run all lanes. Sharding preserves every declared test. Evidence reuse and promotion helpers refuse mismatched revisions, inputs, or failed checks.

## Install

Until an npm registry release is published, install the GitHub release:

```sh
npm install --save-dev github:mitchellhwright/firehosePR#v0.1.0
npx fpr init
npx fpr plan --base HEAD~1 --head HEAD
```

The repository includes compiled JavaScript and type declarations. The release also includes an installable `.tgz`. Neither GitHub publication nor this documentation means the npm name has been reserved or published.

Review the generated `firehosepr.json`: each lane must own every input it reads. Configure command arrays and optionally a complete test inventory with timing hints. See [configuration](docs/configuration.md) and the [GitHub Actions example](examples/github-actions/README.md).

## What's included

| Layer | Contents |
| --- | --- |
| CLI and core library | Change planning, deterministic weighted shards, Git tree fingerprints, required shard results, evidence and promotion decisions |
| Extracted library | Exact dependency cache keys, bounded GitHub read retries, log readiness, iOS partitioning and compiled inventory, interrupted-build guards, sealed product/toolchain receipts |
| Reference snapshot | Sanitized CI/CT/CD controllers, workflow generation, runner coordination, Xcode Cloud, TestFlight and deployment examples |

```js
import { balanceTests, requireLaneResults } from 'firehosepr';

const shards = balanceTests([
  { path: 'tests/checkout.test.js', seconds: 80 },
  { path: 'tests/search.test.js', seconds: 25 },
  { path: 'tests/account.test.js', seconds: 30 },
], 2);
console.log(shards);
// After collecting authoritative job results:
requireLaneResults({ lanes: [{ id: 'tests', shards }] }, { tests: ['success', 'success'] });
```

Advanced extracted modules are available through `firehosepr/ci/*`, for example `firehosepr/ci/ios/uiTestPartition`. Read their source contracts before integration.

## CI, continuous testing, and delivery

The executable example runs affected lanes on pull requests and merge groups, and all lanes on main, schedule, and manual runs. Its aggregate gate fails when planning or any selected shard fails. Configure branch protection to require that gate; FirehosePR never changes protections.

Build products and test evidence have different validity scopes. The library exposes decision functions; it does not authenticate receipts, collect GitHub checks, automatically skip tests, merge PRs, or deploy. Deployment and Xcode Cloud/TestFlight controllers remain adaptation references. See [cache, evidence, and promotion contracts](docs/cache-and-evidence.md).

## Source and performance

The user-selected source is a surviving local snapshot whose newest observed CI file edit is **September 30, 2026**. Original Git metadata was unavailable; this date is not a verified commit, merge, or deployment date. [The manifest](docs/extraction-manifest.json) records original file hashes and sanitized export hashes. The standalone planner is new; extracted helpers retain their original algorithms and focused regressions.

The reference tree is inactive, excluded from npm packages, and not a turnkey pipeline. Its application dependencies, fixtures, runner capacity, secrets, and deployment configuration are not included. Its historical tests are not counted as passing package tests.

No end-to-end speedup or original production timings have been independently reproduced for this package. Savings depend on workload and correct ownership. Measure your baseline and preserve full coverage.

## Develop

```sh
npm ci
npm run check
```

The repository uses its own planner to run a complete, inventory-checked test matrix. Checks compile strict TypeScript, execute regression tests, audit export patterns, and install a packed tarball into a temporary project (using the npm registry for dependencies). Two macOS-only archive/toolchain integration tests require installed Xcode (and `ditto` for archiving). Both pass locally; Linux CI reports 58 passing tests and these two explicit skips. No XCTest suite, Xcode Cloud, TestFlight, or deployment is executed by these checks.

[Contributing](CONTRIBUTING.md) · [Security](SECURITY.md) · [MIT license](LICENSE)
