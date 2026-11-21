import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  NO_NATIVE_JOBS,
  attemptJobsSettled,
  candidateMacMinutes,
  laneOutcomes,
  laneReuseBlockers,
  median,
  replayCandidate,
  sampleMinutes,
  selectedMacLanes,
  type MacLaneMinutes,
  type NativeJobPlan,
  type ReplayJob,
} from '../src/mergeGroupReplay.ts';

const BASE = 'a'.repeat(40);
const HEAD = 'b'.repeat(40);
const SHA = 'c'.repeat(40);

function job(name: string, steps: Record<string, string | null>, conclusion = 'success'): ReplayJob {
  return {
    name, conclusion, startedAt: '2026-09-20T10:00:00Z', completedAt: '2026-09-20T10:30:00Z',
    steps: Object.entries(steps).map(([stepName, stepConclusion]) => ({ name: stepName, conclusion: stepConclusion })),
  };
}

describe('replayCandidate', () => {
  it('reads a queue-style merge commit as B = P1 and H = P2', () => {
    assert.deepEqual(
      replayCandidate({ sha: SHA, parents: [BASE, HEAD], subject: 'Merge pull request #6031 from example-org/x' }),
      { kind: 'merge', prNumber: '6031', baseSha: BASE, prHeadSha: HEAD },
    );
  });

  it('reads a squash commit by its (#N) suffix', () => {
    assert.deepEqual(
      replayCandidate({ sha: SHA, parents: [BASE], subject: 'fix(ci): thing (#6198)' }),
      { kind: 'squash', prNumber: '6198', baseSha: BASE },
    );
  });

  it('leaves direct commits and unlabelled merges unattributed', () => {
    assert.equal(replayCandidate({ sha: SHA, parents: [BASE], subject: 'hotfix' }).kind, 'unattributed');
    assert.equal(replayCandidate({ sha: SHA, parents: [BASE, HEAD], subject: "Merge branch 'main'" }).kind, 'unattributed');
    assert.equal(replayCandidate({ sha: SHA, parents: [], subject: 'root (#1)' }).kind, 'unattributed');
  });
});

describe('selectedMacLanes', () => {
  const outputs = new Map([
    ['should_run', 'true'], ['main_required', 'true'], ['evidence_required', 'false'],
    ['storekit_required', 'false'], ['onboarding_required', 'true'], ['chat_plaid_required', 'false'],
    ['income_required', 'false'], ['budget_required', 'true'],
  ]);

  it('maps gate outputs to Mac lanes and drops Budget while its switch is off', () => {
    assert.deepEqual([...selectedMacLanes(outputs, false)], ['native', 'onboarding']);
    assert.deepEqual([...selectedMacLanes(outputs, true)], ['native', 'onboarding', 'budget']);
  });

  it('selects nothing when iOS does not run', () => {
    assert.equal(selectedMacLanes(new Map([...outputs, ['should_run', 'false']]), true).size, 0);
  });
});

describe('laneOutcomes', () => {
  it('reads each lane from the step that runs its tests, never from a skipped job', () => {
    const outcomes = laneOutcomes([
      job('Build shared native iOS test products', {
        'Run StoreKit purchase test': 'success', 'Record StoreKit result': 'success',
      }),
      job('Test - iOS execution (native1)', { 'Execute Precompiled iOS Tests': 'success' }),
      job('Test - iOS execution (native2)', { 'Execute Precompiled iOS Tests': 'failure' }, 'failure'),
      job('Test - iOS execution (evidence-visual)', { 'Execute Precompiled iOS Tests': 'skipped' }),
      job('Real-server E2E execution (onboarding)', { 'Run onboarding E2E': 'success' }),
      job('Real-server E2E execution (income)', {}, 'skipped'),
      job('StoreKit Purchase - iOS', { 'Verify consolidated StoreKit execution result': 'success' }),
    ]);
    assert.deepEqual(Object.fromEntries(outcomes), { native: 'failed', storekit: 'passed', onboarding: 'passed' });
  });

  it('reads StoreKit from the aggregate verdict, since the purchase and record steps never fail', () => {
    // A failed purchase test: its step continues on error and the record step only writes an output.
    const build = job('Build shared native iOS test products', {
      'Run StoreKit purchase test': 'success', 'Record StoreKit result': 'success',
    });
    const verdict = (conclusion: string | null) => job('StoreKit Purchase - iOS', {
      'Verify consolidated StoreKit execution result': conclusion,
    }, conclusion ?? 'cancelled');
    assert.equal(laneOutcomes([build, verdict('failure')]).get('storekit'), 'failed');
    assert.equal(laneOutcomes([build, verdict('success')]).get('storekit'), 'passed');
    assert.equal(laneOutcomes([build, verdict(null)]).get('storekit'), undefined);
    assert.equal(laneOutcomes([build]).get('storekit'), undefined);
    // An aggregate pass without the purchase step running is "not required", not StoreKit evidence.
    assert.equal(laneOutcomes([job('Build shared native iOS test products', {}), verdict('success')]).get('storekit'), undefined);
  });

  it('fails a lane whose tests passed but whose job failed a later step', () => {
    const outcomes = laneOutcomes([
      job('Real-server E2E execution (onboarding)', {
        'Run onboarding E2E': 'success', 'Validate development FullOnboarding evidence': 'failure',
      }, 'failure'),
      job('Test - iOS execution (native1)', { 'Execute Precompiled iOS Tests': 'success' }, 'cancelled'),
    ]);
    assert.equal(outcomes.get('onboarding'), 'failed');
    assert.equal(outcomes.get('native'), undefined);
  });

  it('never proves a matrix lane from a partial run: one job passed, another never ran its tests', () => {
    const outcomes = laneOutcomes([
      job('Test - iOS execution (native1)', { 'Execute Precompiled iOS Tests': 'success' }),
      job('Test - iOS execution (native2)', {}, 'cancelled'),
      job('Test - iOS execution (evidence-visual)', { 'Execute Precompiled iOS Tests': 'success' }),
      job('Test - iOS execution (evidence-account-update)', { 'Execute Precompiled iOS Tests': 'cancelled' }, 'cancelled'),
    ]);
    assert.equal(outcomes.get('native'), undefined);
    assert.equal(outcomes.get('evidence'), undefined);
  });

  it('needs every Budget shard to pass and fails the lane on any failed shard', () => {
    const passedShard = job('Real-server E2E execution (budget-a)', { 'Run Budget real-server E2E': 'success' });
    const skippedShard = job('Real-server E2E execution (budget-b)', { 'Run Budget real-server E2E': null });
    const failedShard = job('Real-server E2E execution (budget-b)', { 'Run Budget real-server E2E': 'failure' });
    assert.equal(laneOutcomes([passedShard, skippedShard]).get('budget'), undefined);
    assert.equal(laneOutcomes([passedShard, failedShard]).get('budget'), 'failed');
    assert.equal(laneOutcomes([passedShard, { ...failedShard, steps: passedShard.steps }]).get('budget'), 'passed');
  });
});

describe('laneReuseBlockers', () => {
  it('admits native reuse when nothing in the Mac closure changed', () => {
    assert.deepEqual(laneReuseBlockers('native', ['server/services/chat/foo.ts', 'docs/x.md']), []);
  });

  it('blocks native reuse on an iOS input, the iOS workflow, or the root lockfile', () => {
    assert.deepEqual(laneReuseBlockers('native', ['ios/example-ios/App.swift']), ['ios/example-ios/App.swift']);
    assert.deepEqual(laneReuseBlockers('evidence', ['.github/workflows/ios-tests.yml']), ['.github/workflows/ios-tests.yml']);
    assert.deepEqual(laneReuseBlockers('storekit', ['package-lock.json']), ['package-lock.json']);
  });

  it('blocks a real-server lane on a server change it owns or a schema change', () => {
    assert.deepEqual(laneReuseBlockers('onboarding', ['pages/api/[...path].ts']), ['pages/api/[...path].ts']);
    assert.ok(laneReuseBlockers('income', ['server/db/migrations/0001.sql'])?.includes('server/db/migrations/0001.sql'));
    assert.deepEqual(laneReuseBlockers('native', ['server/db/migrations/0001.sql']), []);
  });

  it('blocks every real-server lane on a runtime input every lane loads', () => {
    for (const path of ['next.config.mjs', 'shared/schemas/userProfile.ts']) {
      for (const lane of ['onboarding', 'chat-plaid', 'income', 'budget'] as const) {
        assert.deepEqual(laneReuseBlockers(lane, [path]), [path], `${lane} ${path}`);
      }
      assert.deepEqual(laneReuseBlockers('native', [path]), [], path);
    }
    for (const path of ['server/tests/chat.test.ts', 'pages/index.tsx']) {
      assert.deepEqual(laneReuseBlockers('chat-plaid', [path]), [], path);
    }
  });

  it('blocks only Chat-Plaid on a chat docs change', () => {
    const path = 'server/docs/CHAT_ARCHITECTURE.md';
    assert.deepEqual(laneReuseBlockers('chat-plaid', [path]), [path]);
    for (const lane of ['native', 'onboarding', 'income', 'budget'] as const) {
      assert.deepEqual(laneReuseBlockers(lane, [path]), [], lane);
    }
  });

  it('fails closed when the server comparison is too large to judge', () => {
    const many = Array.from({ length: 300 }, (_, index) => `server/services/generated/file${index}.ts`);
    assert.equal(laneReuseBlockers('onboarding', many), undefined);
    assert.deepEqual(laneReuseBlockers('native', many), []);
  });
});

describe('candidateMacMinutes', () => {
  const minutes: MacLaneMinutes = {
    nativeBuild: 10, releaseArchive: 5,
    execution: {
      native1: 11, native2: 12, native3: 13, native4: 14,
      'evidence-account-update': 20, 'evidence-account-update-2': 21, 'evidence-visual': 22,
    },
    e2eBuild: 4,
    realServer: { onboarding: 12, 'chat-plaid': 6, income: 7, budget: 9 },
  };
  const scheduled: NativeJobPlan = {
    releaseArchive: true, executionLanes: ['native1', 'native3', 'evidence-visual'],
  };

  it('charges each shared build once and only the jobs the native plan schedules', () => {
    // build 10 + archive 5 + native1 11 + native3 13 + evidence-visual 22
    assert.equal(candidateMacMinutes(new Set(['native', 'evidence', 'storekit']), scheduled, minutes), 61);
    assert.equal(candidateMacMinutes(new Set(['onboarding', 'income']), scheduled, minutes), 23);
    assert.equal(candidateMacMinutes(new Set(), scheduled, minutes), 0);
  });

  it('charges a unit-preflight-only native plan the shared build alone', () => {
    assert.equal(candidateMacMinutes(new Set(['native']), NO_NATIVE_JOBS, minutes), 10);
  });

  it('charges the archive and native lanes only with the native lane, evidence lanes only with evidence', () => {
    assert.equal(candidateMacMinutes(new Set(['evidence']), scheduled, minutes), 32);
    assert.equal(candidateMacMinutes(new Set(['native']), scheduled, minutes), 39);
  });
});

describe('attemptJobsSettled', () => {
  const done = { status: 'completed' };

  it('caches only a completed run whose page lists every job, all completed', () => {
    assert.equal(attemptJobsSettled('completed', { total_count: 2, jobs: [done, done] }), true);
  });

  it('never caches an empty answer, even for a run reported completed', () => {
    assert.equal(attemptJobsSettled('in_progress', { total_count: 0, jobs: [] }), false);
    assert.equal(attemptJobsSettled('completed', { total_count: 0, jobs: [] }), false);
  });

  it('never caches a run still in progress, a partial page, or an unfinished job', () => {
    assert.equal(attemptJobsSettled('in_progress', { total_count: 1, jobs: [done] }), false);
    assert.equal(attemptJobsSettled(null, { total_count: 1, jobs: [done] }), false);
    assert.equal(attemptJobsSettled('completed', { total_count: 3, jobs: [done, done] }), false);
    assert.equal(attemptJobsSettled('completed', { total_count: 2, jobs: [done, { status: 'queued' }] }), false);
  });
});

describe('sampleMinutes', () => {
  it('sums successful samples and rejects one with any unfinished, cancelled or failed job', () => {
    const done = job('Test - iOS execution (native1)', {});
    const running = { ...job('Test - iOS execution (native2)', {}), completedAt: null };
    assert.equal(sampleMinutes([done, done]), 60);
    assert.equal(sampleMinutes([done, running]), undefined);
    assert.equal(sampleMinutes([]), undefined);
    assert.equal(sampleMinutes([done, job('Test - iOS execution (native3)', {}, 'cancelled')]), undefined);
    assert.equal(sampleMinutes([done, job('Test - iOS execution (native4)', {}, 'failure')]), undefined);
  });
});

describe('median', () => {
  it('handles empty, odd and even samples', () => {
    assert.equal(median([]), 0);
    assert.equal(median([3, 1, 2]), 2);
    assert.equal(median([4, 1, 2, 3]), 2.5);
  });
});
