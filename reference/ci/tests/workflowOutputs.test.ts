import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import {
  declaredOutputs,
  loadWorkflowGraph,
  outputValidatedWorkflows,
  parseWorkflowGraph,
  validateWorkflowOutputs,
  workflowOutputContract,
} from '../src/workflowOutputs.ts';
import { ciEventCondition, ciEventFieldSource } from '../workflows/lib/ciEvent.ts';

test('every validated workflow resolves each inter-job and step reference and reads every output', () => {
  for (const path of outputValidatedWorkflows) {
    assert.deepEqual(validateWorkflowOutputs(loadWorkflowGraph(path)), [], path);
  }
});

test('declared job outputs match the pinned contract exactly', () => {
  for (const [path, jobs] of Object.entries(workflowOutputContract)) {
    const declared = declaredOutputs(loadWorkflowGraph(path));
    const pinned = Object.fromEntries(
      Object.entries(jobs).map(([job, outputs]) => [job, [...outputs].sort()]),
    );
    assert.deepEqual(declared, pinned, path);
  }
});

test('first-promotion verifier refs stay pinned to the proved checkpoint', () => {
  const jobs = loadWorkflowGraph('.github/workflows/ios-tests.yml').jobs;
  const verifierRef = '${{ needs.ios-change-gate.outputs.verifier_sha }}';
  const gate = jobs['ios-change-gate'];
  assert.ok(gate);
  const precheck = gate.steps?.find(step => step.name === 'Checkout trusted iOS gate precheck');
  assert.equal(
    precheck?.with?.ref,
    `\${{ ${ciEventCondition('pullRequestIntoMain')} && 'develop' || ${ciEventFieldSource('trustedBaseSha')} }}`,
  );
  assert.equal(gate.outputs?.verifier_sha, "${{ steps.precheck.outputs.verifier_sha || '' }}");

  const schema = jobs['prepare-dev-e2e-schema'];
  assert.ok(schema);
  const schemaCheckout = schema.steps?.find(step => step.name === 'Checkout trusted schema verifier');
  const revisionCheck = schema.steps?.find(step => step.name === 'Verify trusted schema verifier revision');
  assert.equal(schemaCheckout?.with?.ref, verifierRef);
  assert.equal(revisionCheck?.env?.TRUSTED_VERIFIER_SHA, verifierRef);

  for (const [jobId, program] of [
    ['verify-ios-release-archive', 'verifyExactReleaseArchiveRevision.ts'],
    ['build-ios-native-test-products', 'verifyExactIosRevision.ts'],
    ['build-ios-e2e-test-products', 'verifyExactIosRevision.ts'],
    ['test-ios-execution', 'verifyExactIosRevision.ts'],
  ] as const) {
    const job = jobs[jobId];
    assert.ok(job, jobId);
    const guard = job.steps?.find(step => step.run?.includes(program));
    assert.equal(guard?.env?.EXAMPLE_CI_GUARD_SHA, verifierRef, jobId);
    const source = readFileSync(`ci/src/actions/ios/${program}`, 'utf8');
    assert.match(source, /macRevisionAdmission\(import.meta.url\)/, program);
    const admission = readFileSync('ci/src/ios/macRevisionAdmission.ts', 'utf8');
    assert.match(admission, /trustedGuardRevisionDecision\(entryUrl, requiredEnv\('EXAMPLE_CI_GUARD_SHA'\)\)/);
  }

  for (const jobId of ['onboarding-e2e', 'chat-plaid-e2e', 'income-e2e', 'budget-e2e']) {
    const job = jobs[jobId];
    assert.ok(job, jobId);
    const checkout = job.steps?.find(step => step.name === 'Checkout typed iOS revision guard');
    assert.equal(checkout?.with?.ref,
      '${{ needs.ios-change-gate.outputs.verifier_sha || env.EXAMPLE_CI_TRUSTED_BASE_SHA }}', jobId);
    assert.equal(checkout?.with?.path, '.ci/trusted-ios-revision-guard', jobId);
    assert.equal(checkout?.with?.['sparse-checkout'], 'ci\n', jobId);
    const guard = job.steps?.find(step => step.name === 'Verify exact iOS test revision');
    assert.equal(guard?.env?.EXAMPLE_CI_GUARD_SHA, verifierRef, jobId);
    assert.equal(guard?.run,
      'node .ci/trusted-ios-revision-guard/ci/src/actions/ios/verifyExactIosRevision.ts', jobId);
    const names = job.steps?.map(step => step.name);
    assert.ok(names);
    assert.ok(names.indexOf('Checkout typed iOS revision guard')
      < names.indexOf('Set up the Node.js runtime'), jobId);
    assert.ok(names.indexOf('Set up the Node.js runtime')
      < names.indexOf('Verify exact iOS test revision'), jobId);
    assert.ok(names.indexOf('Verify exact iOS test revision')
      < names.indexOf('Select exact Xcode'), jobId);
  }
});

test('a renamed output, a missing dependency and a dead output are each reported', () => {
  const graph = parseWorkflowGraph(`
jobs:
  gate:
    outputs:
      should_run: \${{ steps.detect.outputs.should_run }}
      unread: \${{ steps.missing.outputs.value }}
    steps:
      - id: detect
        run: echo should_run=true >> "$GITHUB_OUTPUT"
  build:
    needs: [gate]
    if: needs.gate.outputs.should_build == 'true'
    steps:
      - run: echo build
  report:
    if: needs.gate.result == 'success'
    steps:
      - name: "\${{ needs.gate.outputs.should_run }}"
        run: echo report
`);
  const messages = validateWorkflowOutputs(graph).map((issue) => `${issue.job}: ${issue.message}`).sort();
  assert.deepEqual(messages, [
    'build: reads needs.gate.outputs.should_build, which "gate" does not declare',
    'gate: declares output "should_run", which no other job reads',
    'gate: declares output "unread", which no other job reads',
    'gate: references steps.missing, which is not a step id in this job',
    'report: reads needs.gate.outputs.should_run but does not list "gate" in needs',
    'report: reads needs.gate.result but does not list "gate" in needs',
  ]);
});
