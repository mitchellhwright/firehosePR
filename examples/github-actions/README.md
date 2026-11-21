# GitHub Actions integration

1. Install FirehosePR as a dev dependency and commit your lockfile.
2. Copy `firehosepr.json` to the repository root and configure complete lane input ownership. The initial example runs `npm test` once; add a complete `tests` array with duration hints to enable parallel shards.
3. Copy `firehosepr.yml` to `.github/workflows/`.
4. Require the **FirehosePR gate** status through your normal branch protection workflow. Review ownership and workflow changes.

The example uses read-only permissions and ephemeral Ubuntu runners, with no secrets. PR tests run against GitHub's merge candidate; merge groups run against the queue candidate. Main/schedule/manual triggers run all lanes. PR refs without a merge parent fail planning. A failed plan cannot become a passing aggregate. No receipt-based skipping or deployment is enabled.

The planner output is carried as JSON, commands are passed as process argument arrays, and failed or cancelled matrix jobs fail the aggregate. For test inventory lanes, test paths are appended to `command`; use runner-compatible argument separators where needed (for example `npm run test --`).

The workflow checks the PR's code and configuration, so it cannot authorize privileged promotion. Do not use `pull_request_target`, secrets, or privileged persistent runners with this example. Keep your trusted release controller separate and validate its exact source/artifact/check identity before deployment.
