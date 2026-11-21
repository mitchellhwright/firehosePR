import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { z } from 'zod';

import { workflowJob, type WorkflowJob } from '../src/workflowStepShell.ts';
import { ciEventFieldSource, mergeGroupProgramRoot } from '../workflows/lib/ciEvent.ts';

const workflow = 'ios-tests.yml';
type Step = NonNullable<WorkflowJob['steps']>[number];
function step(job: WorkflowJob, name: string): Step {
  const found = job.steps?.find((candidate) => candidate.name === name);
  assert.ok(found, `missing workflow step: ${name}`);
  return found;
}

describe('retained native evidence workflow', () => {
  it('feeds the trusted controller retry decision into typed change detection', () => {
    const gate = workflowJob(workflow, 'ios-change-gate');
    const detection = step(gate, 'Detect iOS Changes');
    assert.equal(detection.run, 'node "$IOS_CHANGE_DETECTOR_ROOT/ci/src/actions/ios/detectIosChanges.ts"');
    // A pull request keeps its head's detector; a queue candidate runs the queue base's.
    assert.equal(detection.env?.IOS_CHANGE_DETECTOR_ROOT,
      `\${{ ${mergeGroupProgramRoot('.ci/trusted-ios-detector').expression} }}`);
    assert.equal(detection.env?.CONTROLLER_BASE_UPDATE_REUSE_NATIVE_EVIDENCE,
      "${{ steps.base-update.outputs.reuse_native_evidence || 'false' }}");
    assert.equal(detection.env?.FORCED_IOS_AUXILIARY,
      "${{ steps.base-update.outputs.rerun_ios_auxiliary || '[]' }}");
    assert.equal(detection.env?.FORCED_IOS_LANES,
      "${{ steps.base-update.outputs.rerun_ios_lanes || '[]' }}");
    const gateOutputs = z.object({
      native_changed_files: z.string(),
      native_changed_files_explicit_empty: z.string(),
      native_should_run: z.string(),
    }).parse(gate.outputs);
    assert.match(gateOutputs.native_changed_files, /steps\.detect\.outputs\.native_changed_files/);
    assert.match(gateOutputs.native_changed_files_explicit_empty,
      /steps\.detect\.outputs\.native_changed_files_explicit_empty/);
    assert.match(gateOutputs.native_should_run, /steps\.classify\.outputs\.producer_mode != 'skip'/);
  });

  it('passes an explicitly empty retained or promotion inventory to every native selector', () => {
    const gate = workflowJob(workflow, 'ios-change-gate');
    const selection = step(gate, 'Select native iOS tests');
    const checkout = step(gate, 'Checkout iOS change selector');
    const selectionHead = String(selection.env?.IOS_AFFECTED_TESTS_HEAD);
    assert.equal(checkout.with?.ref, selectionHead);
    assert.match(selectionHead, /production_promotion == 'true' && steps\.precheck\.outputs\.checkpoint_sha/);
    assert.ok(selectionHead.includes(`production_promotion != 'true' && ${ciEventFieldSource('headSha')})`));
    assert.doesNotMatch(selectionHead, /\?/);
    assert.equal(selection.env?.IOS_AFFECTED_TESTS_CHANGED_FILES_EXPLICIT_EMPTY,
      "${{ (github.event_name == 'workflow_dispatch' && inputs.test_scope == 'promotion-evidence' || steps.precheck.outputs.production_promotion == 'true') && steps.detect.outputs.native_changed_files == '' && 'true' || (steps.detect.outputs.native_changed_files_explicit_empty || 'false') }}");
    assert.match(String(selection.env?.IOS_AFFECTED_TESTS_CHANGED_FILES),
      /steps\.detect\.outputs\.native_changed_files/);

    for (const [jobId, stepName] of [
      ['build-ios-native-test-products', 'Determine native build selection'],
      ['test-ios-execution', 'Determine Affected iOS Tests'],
    ] as const) {
      const job = workflowJob(workflow, jobId);
      const consumer = step(job, stepName);
      assert.equal(consumer.env?.IOS_AFFECTED_TESTS_CHANGED_FILES_EXPLICIT_EMPTY,
        '${{ needs.ios-change-gate.outputs.native_changed_files_explicit_empty }}');
      assert.match(String(consumer.env?.IOS_AFFECTED_TESTS_CHANGED_FILES),
        /needs\.ios-change-gate\.outputs\.native_changed_files/);
      assert.doesNotMatch(String(consumer.env?.IOS_AFFECTED_TESTS_CHANGED_FILES),
        /needs\.ios-change-gate\.outputs\.changed_files(?:\W|$)/);
    }
    assert.match(String(workflowJob(workflow, 'build-ios-native-test-products').if),
      /needs\.ios-change-gate\.outputs\.native_should_run == 'true'/);
  });

  it('explicitly empty native inventory skips selection without Git history fallback', () => {
    const directory = mkdtempSync(join(tmpdir(), 'example-retained-selector-'));
    try {
      const output = join(directory, 'outputs');
      const result = spawnSync(process.execPath, ['scripts/select-ios-affected-tests.ts'], {
        encoding: 'utf8',
        env: {
          ...process.env,
          GITHUB_ACTIONS: 'true',
          GITHUB_OUTPUT: output,
          IOS_AFFECTED_TESTS_CHANGED_FILES: '',
          IOS_AFFECTED_TESTS_CHANGED_FILES_EXPLICIT_EMPTY: 'true',
          IOS_AFFECTED_TESTS_BASE: 'nonexistent-retained-base',
          IOS_AFFECTED_TESTS_HEAD: 'nonexistent-retained-head',
          IOS_AFFECTED_TESTS_LANE: 'main',
          IOS_AFFECTED_TESTS_MODE: 'affected',
          IOS_AFFECTED_TESTS_STOREKIT_REQUIRED: 'false',
        },
      });
      assert.equal(result.status, 0, result.stderr);
      const selected = readFileSync(output, 'utf8');
      assert.match(selected, /^mode=skip$/m);
      assert.match(selected, /^should_run=false$/m);
      assert.match(selected, /^test_count=0$/m);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('a deleted legacy contract test alone cannot book native XCTest', () => {
    const directory = mkdtempSync(join(tmpdir(), 'example-deleted-contract-selector-'));
    try {
      const output = join(directory, 'outputs');
      const result = spawnSync(process.execPath, ['scripts/select-ios-affected-tests.ts'], {
        encoding: 'utf8',
        env: {
          ...process.env,
          GITHUB_OUTPUT: output,
          IOS_AFFECTED_TESTS_CHANGED_FILES:
            'scripts/tests/workflow-runner-configuration.test.mjs',
          IOS_AFFECTED_TESTS_LANE: 'main',
          IOS_AFFECTED_TESTS_MODE: 'affected',
        },
      });
      assert.equal(result.status, 0, result.stderr);
      const selected = readFileSync(output, 'utf8');
      assert.match(selected, /^mode=skip$/m);
      assert.match(selected, /^should_run=false$/m);
      assert.match(selected, /^test_count=0$/m);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('wires separate required verdicts to the actual gate and execution outcomes', () => {
    const native = step(workflowJob(workflow, 'test-ios'), 'Verify iOS test lanes');
    assert.equal(native.run, 'node ci/src/actions/ios/verifyNativeTestLanes.ts');
    assert.equal(native.env?.CHANGE_GATE_RESULT, '${{ needs.ios-change-gate.result }}');
    assert.equal(native.env?.MAIN_EXECUTION_RESULT, '${{ needs.test-ios-execution.result }}');
    assert.equal(native.env?.RELEASE_ARCHIVE_RESULT,
      '${{ needs.verify-ios-release-archive.result }}');

    const onboarding = step(workflowJob(workflow, 'onboarding-e2e-status'),
      'Verify onboarding execution result');
    assert.equal(onboarding.run, 'node ci/src/actions/ios/verifyRealServerE2eStatus.ts');
    assert.equal(onboarding.env?.CHANGE_GATE_RESULT, '${{ needs.ios-change-gate.result }}');
    for (const [lane, variable] of [
      ['onboarding-e2e', 'EXECUTION_RESULT'],
      ['chat-plaid-e2e', 'CHAT_PLAID_EXECUTION_RESULT'],
      ['budget-e2e', 'BUDGET_EXECUTION_RESULT'],
    ] as const) {
      assert.equal(onboarding.env?.[variable], `\${{ needs.${lane}.result }}`);
    }

    const storekit = step(workflowJob(workflow, 'storekit-purchase-status'),
      'Verify consolidated StoreKit execution result');
    assert.match(String(storekit.run), /verifyStorekitPurchaseStatus\.ts$/);
    assert.equal(storekit.env?.EXECUTION_RESULT,
      '${{ needs.build-ios-native-test-products.outputs.storekit_result }}');
    assert.equal(storekit.env?.PARENT_EXECUTION_RESULT,
      '${{ needs.build-ios-native-test-products.result }}');
  });
});
