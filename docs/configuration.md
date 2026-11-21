# Configuration

Run `fpr init` to create `firehosepr.json`. It never overwrites an existing file.

```json
{
  "schemaVersion": 1,
  "maxShards": 4,
  "globalInputs": ["package.json", "package-lock.json", ".github/", "firehosepr.json"],
  "ignoredPaths": [],
  "lanes": [
    {
      "id": "api",
      "inputs": ["server/", "shared/", "tests/api/"],
      "command": ["node", "--test"],
      "tests": [
        {"path": "tests/api/slow.test.js", "seconds": 90},
        {"path": "tests/api/fast.test.js", "seconds": 10}
      ]
    },
    {
      "id": "web",
      "inputs": ["web/", "shared/", "tests/web/"],
      "command": ["npm", "run", "test:web"]
    }
  ]
}
```

Inputs are exact file names or directory prefixes ending with `/`. Globs are rejected. Each lane must declare its entire dependency closure, including shared code, generated inputs, fixtures, and configuration. A test that reads a document makes that document a test input. A path can belong to several lanes.

Unknown changed paths select every lane. Global inputs select every lane. `ignoredPaths` is empty by default; only explicitly ignored paths can produce a plan with no lanes. Declared lane and global inputs take precedence over ignores. `--full` selects all lanes even with no changes, for scheduled continuous testing and release validation.

Tests, when declared, are a complete lane inventory. Duration hints influence placement only; every declared test is scheduled exactly once. FirehosePR does not infer dynamic imports, discover tests, or verify a consumer's ownership map. Reconcile the inventory with the runner's collected tests and run full suites on a schedule.

```sh
fpr plan --base BASE_COMMIT --head HEAD_COMMIT --out firehosepr-plan.json
fpr plan --base HEAD --head HEAD --full
fpr fingerprint --ref HEAD
fpr shard --tests test-durations.json --count 4
```

Use the actual merge candidate for `--head` and its actual base parent for `--base`. Fetch those commits first. Missing Git objects are errors; the tool does not silently assume an empty diff. A rename selects both old and new paths. Fingerprints cover the entire tracked tree, including modes, object IDs, and submodule entries; untracked work is not included.

The plan is JSON containing immutable base/head IDs, tree/config digests, reasons, and shard inventories. Commands remain executable/argument arrays. Execute them with a process API such as `spawnSync`, never string interpolation into a shell. For lanes with tests, append the shard's test paths to the command array. Without tests, run the command once.

Protect ownership configuration and workflow changes with reviews. A PR-controlled planner is not a security boundary. Privileged controllers must use a trusted revision of both the planner and policy, independently verify live GitHub state, and never execute candidate code with secrets or on a persistent privileged runner.
