import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { z } from 'zod';

import { reservedMacLabels, sharedMacLabels } from '../src/ios/iosRunnerCapabilities.ts';
import { workflowContractRegistry } from '../src/workflowContract.ts';
import { workflowJob } from '../src/workflowStepShell.ts';

const jobSchema = z.object({
  'runs-on': z.unknown(),
  steps: z.array(z.object({ name: z.string().optional() }).passthrough()),
}).passthrough();

const NATIVE_JOBS: readonly string[] = [
  'verify-ios-release-archive',
  'build-ios-native-test-products',
  'test-ios-execution',
];

describe('native iOS Mac routing', () => {
  for (const id of NATIVE_JOBS) {
    it(`${id} requires a physical Mac with the selected capability labels`, () => {
      const job = jobSchema.parse(workflowJob('ios-tests.yml', id));
      const route = z.object({ group: z.string(), labels: z.string() }).parse(job['runs-on']);
      assert.match(route.group, /example-reviewed-pr-macs/);
      assert.ok(route.labels.includes(JSON.stringify(sharedMacLabels)));
      assert.ok(route.labels.includes(JSON.stringify(reservedMacLabels)));
      assert.doesNotMatch(JSON.stringify(route), /(?:macos-\d+|xcode-\d+)/i);
      assert.ok(!job.steps.some((step) => step.name === 'Verify hosted macOS runner capacity'));
    });
  }

  it('declares all native execution jobs as physical Mac lanes', () => {
    const lanes = workflowContractRegistry.lanes.filter((lane) => NATIVE_JOBS.includes(lane.jobId));
    assert.equal(lanes.length, NATIVE_JOBS.length);
    for (const lane of lanes) assert.equal(lane.runnerClass, 'macos-physical', lane.jobId);
  });
});
