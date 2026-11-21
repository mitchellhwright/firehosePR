import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import { load } from 'js-yaml';
import { z } from 'zod';

const workflowSchema = z.object({
  on: z.record(z.string(), z.unknown()),
  concurrency: z.object({ group: z.string(), 'cancel-in-progress': z.boolean() }),
  jobs: z.record(z.string(), z.object({ if: z.string().optional() }).passthrough()),
}).passthrough();

function workflow(file: string): z.infer<typeof workflowSchema> {
  return workflowSchema.parse(load(readFileSync(`.github/workflows/${file}`, 'utf8')));
}

test('only merged PRs signal validation concurrency without allocating a runner', () => {
  const pairs = [
    ['native-terminal-pr-checks-cancel.yml', 'pr-checks.yml', 'pr-checks-', 'pr-checks-', 'toJSON(github.event.pull_request.number)', 'pr-checks'],
    ['native-terminal-ios-cancel.yml', 'ios-tests.yml', 'ios-run-pr-', 'ios-run-', "toJSON(format('pr-{0}', github.event.pull_request.number))", 'ios'],
  ] as const;

  for (const [signalFile, validationFile, signalPrefix, validationPrefix, validationPrKey, kind] of pairs) {
    const signal = workflow(signalFile);
    const validation = workflow(validationFile);
    assert.deepEqual(signal.on['pull_request_target'], {
      types: ['closed'],
    });
    assert.equal(signal.concurrency.group,
      "${{ github.event.action == 'closed' && github.event.pull_request.merged == true "
      + `&& format('${signalPrefix}{0}', github.event.pull_request.number) `
      + `|| format('terminal-${kind}-{0}', github.run_id) }}`);
    assert.equal(signal.concurrency['cancel-in-progress'], true);
    assert.ok(validation.concurrency.group.startsWith(validationPrefix), validationFile);
    assert.ok(validation.concurrency.group.includes(validationPrKey), validationFile);
    assert.deepEqual(Object.keys(signal.jobs), ['terminal-signal']);
    assert.equal(signal.jobs['terminal-signal']?.if,
      "github.event.action == 'opened'");
  }
});
