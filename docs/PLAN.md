# Extraction and delivery plan

1. Inventory CI controllers, generated workflows, tests, runner tooling, and continuous testing/deployment adapters. Record source and export hashes for traceability.
2. Locate the newest surviving local source. Git metadata is missing, so file dates must not be represented as commit or release dates. The user selected the September 30 snapshot for publication.
3. Separate the portable package from a sanitized, inactive reference snapshot. Retain production-tested algorithms where independent of application code. Replace product-specific policy with explicit consumer configuration.
4. Test conservative selection, deletion/rename handling, complete shard inventory, exact input reuse refusal, promotion identity, interrupted-build recovery, and package installation in an isolated directory.
5. Scan the export for credentials and private destinations, inspect the package tarball, and lint executable GitHub workflows. Do not publish application files, recorded evidence, environment files, or runner installations.
6. Create the authorized public repository `mitchellhwright/firehosePR`, push, and verify its CI on the published revision before tagging a release.

## Naming

Confirmed by the user: **FirehosePR**; package **firehosepr**; executable **fpr**.
The npm registry had no `firehosepr` package when checked on November 21, 2026. This does not reserve the name or guarantee publication. `fpr`, `prf`, and `firehose` were already registered package names.

## Source search

The initial extraction used the September 29 local worktree. A subsequent search found a newer worktree with September 30 CI edits: 40 added, 98 changed, and 8 removed CI files in the compared directories. No October 7 source checkout or archive was found. October 3 handoffs survive, but the source directories they reference do not. The reference export and portable modules were reconciled with the September 30 snapshot.
