import assert from 'node:assert/strict';
import test from 'node:test';

import { cancelBlockedPrCi } from '../workflows/cancel-blocked-pr-ci.ts';
import { xcodeCloudBuildTags } from '../workflows/xcode-cloud-build-tags.ts';

function assertPinnedNodeBeforeTypedAction(options: {
  readonly workflow: typeof cancelBlockedPrCi;
  readonly jobId: string;
  readonly action: string;
}): void {
  const job = options.workflow.config.jobs.find(candidate => candidate.id === options.jobId);
  assert.ok(job !== undefined);
  const setupIndex = job.config.steps.findIndex(step => step.config.uses === 'actions/setup-node@v7.0.0'
    && step.config.with?.['node-version'] === '26.5.0'
    && step.config.with?.['package-manager-cache'] === false);
  const actionIndex = job.config.steps.findIndex(step => step.config.command === options.action);
  assert.ok(setupIndex >= 0, `${options.jobId} must pin the maintenance Node runtime`);
  assert.ok(actionIndex > setupIndex, `${options.jobId} must set up Node before its typed action`);
}

test('terminal cleanup pins Node before its typed action', () => {
  assertPinnedNodeBeforeTypedAction({
    workflow: cancelBlockedPrCi,
    jobId: 'cancel-blocked-pr-ci',
    action: 'node ci/src/actions/cancelTerminalPrRuns.ts',
  });
});

test('Xcode Cloud build tracking pins Node before its typed action', () => {
  assertPinnedNodeBeforeTypedAction({
    workflow: xcodeCloudBuildTags,
    jobId: 'reconcile',
    action: 'node ci/src/actions/reconcileXcodeCloudBuildTags.ts',
  });
});
