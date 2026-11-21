# Caches and evidence

FirehosePR distinguishes execution from reuse. `requireLaneResults` requires every planned shard to execute successfully; skipped, cancelled, missing, and failed shards fail that gate. It does not accept reuse as execution.

`decideReuse` is a pure, conservative policy function, not an authenticated GitHub collector. It permits reuse only for the same PR head and lane, identical full tracked tree/configuration/environment digests, covered obligations, and the latest successful completed producer run and exact attempt. This accommodates a merge-queue candidate whose relevant source tree is identical. A changed head reruns in the portable policy.

The caller must independently obtain the producer's repository, workflow ID, run/attempt, head and tested merge SHA, latest completed run, job conclusions, workflow trust, and receipt provenance from authenticated GitHub reads. Never populate `trustedWorkflow`, `trustedReceipt`, or any producer facts from candidate-controlled JSON. The tested merge commit must be independently bound to the PR head and base. A receipt alone is not authority. Missing evidence means execute. The public CLI does not automatically skip jobs based on receipts.

Environment fingerprints must include compiler/runtime versions, dependency lockfiles, platform/architecture, toolchain, test flags, relevant environment settings, external fixture versions, and every non-Git input. If inputs are dynamic or cannot be fully identified, rerun. The full reference snapshot shows the original GitHub adapters and more specialized lane-input closures; they are not automatically enabled by the package.

## Dependency trees

`nodeModulesCacheKey` includes both manifests, project `.npmrc`, Node/module ABI, npm, OS/CPU, runner image, installation arguments, `NODE_ENV`, and `npm_config_*` values. `installOrReuse` accepts only an exact cache hit with a matching stamp and a passing `npm ls --depth=0`; otherwise it reinstalls. It may delete `node_modules` in the supplied root. Supply only a dedicated job workspace.

Lifecycle scripts can read arbitrary inputs, including user/global npm configuration and network resources. Consumers must normalize or fingerprint those additional inputs before enabling full dependency-tree caching. This helper cannot prove that arbitrary installation scripts are deterministic. Never use broad restore keys for complete `node_modules`. Restrict cache writes to a trusted branch; fork and untrusted PR jobs must not populate trusted caches.

## iOS build products

The extracted incremental guard marks a build before it starts and removes the marker after an orderly finish. A later build discards marked, interrupted derived data before reuse. Use a dedicated derived-data directory and serialize access; the guard is not a mutual-exclusion lock. Never point it at shared unrelated build output.

The archive helpers retain checksums and producer provenance. UI partitioning rejects missing selected class inventories and duplicate selections. Its source parser is heuristic: reconcile with compiled test enumeration before execution. Explicit exclusions and test-plan skips remain consumer policy; do not use them to hide required coverage. The tuple lifecycle helper retains the historical `Test - iOS` workflow name and returns proposals only; adapt the identity and verify live state before acting. They are library building blocks; an Xcode installation, simulator lifecycle, signing, application fixtures, and protected runner admission remain consumer responsibilities. No hosted macOS runs are part of this project's validation.

## Promotion

`requirePromotion` checks exact current source/tested SHA, artifact digest, environment, and a nonempty set of passing checks. Populate those facts using authoritative platform reads. It does not grant deployment authority, modify branch protection, or deploy anything. Apply environment protection and provider identity controls in the consuming repository.
