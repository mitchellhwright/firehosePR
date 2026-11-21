import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import { dump, load } from 'js-yaml';

import { iosE2eProductWorkflowContract, queueLaneExecutionContract, sameQueueLaneExecutionContract } from '../src/ios/queueLaneExecutionContract.ts';

const source = readFileSync('.github/workflows/ios-tests.yml', 'utf8');

function edited(edit: (workflow: Record<string, unknown>) => void): string {
  const workflow = load(source) as Record<string, unknown>;
  edit(workflow);
  return dump(workflow, { lineWidth: -1 });
}

function jobs(workflow: Record<string, unknown>): Record<string, Record<string, unknown>> {
  return workflow.jobs as Record<string, Record<string, unknown>>;
}

describe('queue lane execution contract', () => {
  it('accepts the checked workflow and ignores comments and display names', () => {
    for (const lane of ['native', 'onboarding', 'chat-plaid', 'income', 'budget'] as const) {
      assert.ok(queueLaneExecutionContract(source, lane), lane);
      assert.equal(sameQueueLaneExecutionContract(source,
        source.replace('name: Test - iOS', 'name: Test - iOS revised') + '\n# harmless comment\n', lane), true);
    }
  });

  it('binds reused evidence to the gate admission dependency without accepting unknown jobs', () => {
    const candidate = edited((workflow) => {
      jobs(workflow)['route-initial-control']!.if = 'false';
    });
    for (const lane of ['native', 'onboarding', 'chat-plaid', 'income', 'budget'] as const) {
      assert.ok(queueLaneExecutionContract(source, lane));
      assert.equal(sameQueueLaneExecutionContract(source, candidate, lane), false);
    }
  });

  it('isolates a changed execution job to the lanes that run it', () => {
    const candidate = edited((workflow) => {
      jobs(workflow)['onboarding-e2e']!.timeout_minutes = 61;
    });
    assert.equal(sameQueueLaneExecutionContract(source, candidate, 'native'), true);
    assert.equal(sameQueueLaneExecutionContract(source, candidate, 'chat-plaid'), true);
    assert.equal(sameQueueLaneExecutionContract(source, candidate, 'onboarding'), false);
  });

  it('invalidates lanes for a shared producer or root environment change', () => {
    const producer = edited((workflow) => {
      jobs(workflow)['build-ios-e2e-test-products']!.timeout_minutes = 61;
    });
    assert.equal(sameQueueLaneExecutionContract(source, producer, 'onboarding'), false);
    assert.equal(sameQueueLaneExecutionContract(source, producer, 'native'), true);
    const environment = edited((workflow) => {
      (workflow.env as Record<string, unknown>).NEW_RUNTIME_SETTING = 'changed';
    });
    assert.equal(sameQueueLaneExecutionContract(source, environment, 'native'), false);
    assert.equal(sameQueueLaneExecutionContract(source, environment, 'budget'), false);
  });

  it('invalidates every consuming lane when the gate changes a Mac execution output', () => {
    const candidate = edited((workflow) => {
      const gate = jobs(workflow)['ios-change-gate']!;
      (gate.outputs as Record<string, unknown>).native_full_execution_lanes = '["native1"]';
    });
    assert.equal(sameQueueLaneExecutionContract(source, candidate, 'native'), false);
    assert.equal(sameQueueLaneExecutionContract(source, candidate, 'onboarding'), false);
  });

  it('binds reused evidence to the downstream required verdict jobs', () => {
    for (const verdictJob of ['test-ios', 'onboarding-e2e-status', 'storekit-purchase-status']) {
      const candidate = edited((workflow) => {
        jobs(workflow)[verdictJob]!.if = 'false';
      });
      for (const lane of ['native', 'onboarding', 'chat-plaid', 'income', 'budget'] as const) {
        assert.equal(sameQueueLaneExecutionContract(source, candidate, lane), false,
          `${verdictJob} must invalidate ${lane}`);
      }
    }
  });

  it('refuses YAML timestamp scalars instead of collapsing distinct dates', () => {
    const withTimestamp = (value: string): string => source.replace(/^env:$/m,
      `env:\n  QUEUE_TIMESTAMP: ${value}`);
    const head = withTimestamp('2026-09-28T12:00:00Z');
    const candidate = withTimestamp('2026-09-29T12:00:00Z');
    assert.notEqual(head, source);
    assert.equal(queueLaneExecutionContract(head, 'native'), null);
    assert.equal(sameQueueLaneExecutionContract(head, candidate, 'native'), false);
  });

  it('refuses YAML integers that js-yaml cannot represent exactly', () => {
    const withInteger = (value: string): string => source.replace(/^env:$/m,
      `env:\n  QUEUE_INTEGER: ${value}`);
    const head = withInteger('9007199254740992');
    const candidate = withInteger('9007199254740993');
    assert.notEqual(head, source);
    assert.equal(queueLaneExecutionContract(head, 'native'), null);
    assert.equal(sameQueueLaneExecutionContract(head, candidate, 'native'), false);
  });

  it('distinguishes numeric spellings passed as environment or action input text', () => {
    const withEnv = (value: string): string => source.replace(/^env:$/m,
      `env:\n  QUEUE_NUMBER: ${value}`);
    assert.equal(sameQueueLaneExecutionContract(withEnv('1'), withEnv('1.0'), 'native'), false);

    const gateStart = source.indexOf('  ios-change-gate:\n');
    assert.ok(gateStart >= 0);
    const inputStart = source.indexOf('fetch-depth: 1', gateStart);
    assert.ok(inputStart >= 0);
    const changedActionInput = source.slice(0, inputStart)
      + source.slice(inputStart).replace('fetch-depth: 1', 'fetch-depth: 1.0');
    assert.notEqual(changedActionInput, source);
    assert.equal(sameQueueLaneExecutionContract(source, changedActionInput, 'native'), false);
  });

  it('refuses unknown root fields, new dependencies and malformed workflow', () => {
    assert.equal(queueLaneExecutionContract('jobs: [', 'native'), null);
    assert.equal(queueLaneExecutionContract(edited((workflow) => {
      workflow.unreviewed = true;
    }), 'native'), null);
    assert.equal(queueLaneExecutionContract(edited((workflow) => {
      jobs(workflow)['test-ios-execution']!.needs = ['ios-change-gate', 'new-job'];
    }), 'native'), null);
  });
});

describe('compiled E2E product workflow contract', () => {
  it('ignores downstream consumers while retaining workflow settings and all producer dependencies', () => {
    const baseline = iosE2eProductWorkflowContract(source);
    assert.ok(baseline);
    assert.equal(iosE2eProductWorkflowContract(edited((workflow) => {
      jobs(workflow)['budget-e2e-video-processing']!.env = { DISPLAY_ONLY: 'changed' };
    })), baseline);
    for (const id of ['build-ios-e2e-test-products', 'ios-change-gate', 'route-initial-control',
      'confirm-current-ios-pr', 'prepare-dev-e2e-schema']) {
      assert.notEqual(iosE2eProductWorkflowContract(edited((workflow) => {
        jobs(workflow)[id]!.env = { CHANGED_INPUT: 'true' };
      })), baseline, id);
    }
    for (const field of ['env', 'permissions', 'concurrency', 'on']) {
      assert.notEqual(iosE2eProductWorkflowContract(edited((workflow) => {
        workflow[field] = { changed: 'true' };
      })), baseline, field);
    }
  });

  it('includes newly declared dependencies and refuses broken dependency graphs and unknown root fields', () => {
    const withDependency = (value: string) => edited((workflow) => {
      jobs(workflow)['additional-product-input'] = { steps: [{ run: value }] };
      jobs(workflow)['build-ios-e2e-test-products']!.needs = ['additional-product-input'];
    });
    assert.ok(iosE2eProductWorkflowContract(withDependency('first')));
    assert.notEqual(iosE2eProductWorkflowContract(withDependency('first')),
      iosE2eProductWorkflowContract(withDependency('second')));
    for (const need of ['missing', 'build-ios-e2e-test-products']) {
      assert.equal(iosE2eProductWorkflowContract(edited((workflow) => {
        jobs(workflow)['build-ios-e2e-test-products']!.needs = need;
      })), null);
    }
    assert.equal(iosE2eProductWorkflowContract(edited((workflow) => { workflow.defaults = { run: { shell: 'bash' } }; })), null);
    assert.equal(iosE2eProductWorkflowContract('jobs: [broken'), null);
  });

  it('preserves text scalar spellings that GitHub passes to actions and programs', () => {
    const fixture = (scalar: string) => `on: {workflow_dispatch: {}}\npermissions: {}\nconcurrency: fixture\nenv: {}\njobs:\n  build-ios-e2e-test-products:\n    steps:\n      - uses: fixture/action@sha\n        with: {value: ${scalar}}\n`;
    assert.ok(iosE2eProductWorkflowContract(fixture('1')));
    assert.notEqual(iosE2eProductWorkflowContract(fixture('1')), iosE2eProductWorkflowContract(fixture('1.0')));
  });
});
