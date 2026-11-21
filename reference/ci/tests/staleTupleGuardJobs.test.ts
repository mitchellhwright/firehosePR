import assert from 'node:assert/strict';
import test from 'node:test';

import { runsStaleTupleGuard, STALE_TUPLE_GUARD_JOB_IDS } from '../src/ios/staleTupleGuardJobs.ts';
import { loadWorkflowGraph } from '../src/workflowOutputs.ts';

const GUARD_PROGRAMS = ['verifyExactIosRevision.ts', 'verifyExactReleaseArchiveRevision.ts'];

test('the stale-tuple guard job set is exactly the rendered jobs that run the guard', () => {
  const { jobs } = loadWorkflowGraph('.github/workflows/ios-tests.yml');
  const guarded = Object.entries(jobs)
    .filter(([, job]) => (job.steps ?? [])
      .some(step => GUARD_PROGRAMS.some(program => step.run?.includes(program) === true)))
    .map(([id]) => id)
    .sort();

  assert.deepEqual([...STALE_TUPLE_GUARD_JOB_IDS].sort(), guarded);
});

test('guarded Mac jobs match by rendered name, including matrix suffixes', () => {
  for (const name of [
    'Test - iOS execution (native1)',
    'Test - iOS execution (evidence-account-update-2)',
    'Build shared native iOS test products',
    'Build shared iOS E2E test products',
    'Verify unsigned Release archive',
    'Real-server E2E execution (onboarding)',
    'Real-server E2E execution (chat-plaid)',
    'Real-server E2E execution (budget-1)',
  ]) {
    assert.equal(runsStaleTupleGuard(name), true, name);
  }
});

test('gate, verdict and aggregation jobs do not run the guard', () => {
  for (const name of [
    'Test - iOS',
    'Onboarding E2E',
    'StoreKit Purchase - iOS',
    'iOS Change Gate',
    'Confirm current iOS PR tuple before Mac allocation',
    'Verify development E2E schema',
    'Budget E2E video processing (non-gating)',
    'Await retained iOS predecessor',
    undefined,
  ]) {
    assert.equal(runsStaleTupleGuard(name), false, String(name));
  }
});
