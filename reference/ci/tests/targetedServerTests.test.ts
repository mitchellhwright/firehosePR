import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  parseTargetedServerTests,
  runTargetedServerTests,
  validateTargetedTestResults,
  type SpawnTargetedTests,
} from '../src/targetedServerTests.ts';

describe('targeted server test execution', () => {
  it('runs only validated changed server test paths', () => {
    let invocation: readonly unknown[] | undefined;
    const spawn: SpawnTargetedTests = (...args) => {
      invocation = args;
      return { status: 0 };
    };
    const status = runTargetedServerTests(
      JSON.stringify(['server/tests/example.test.ts']),
      spawn,
      () => true,
    );
    assert.equal(status, 0);
    assert.deepEqual(invocation?.[1], [
      'vitest',
      'run',
      '--config',
      'server/vitest.config.ts',
      'server/tests/example.test.ts',
    ]);
  });

  it('isolates process-heavy suites selected by an older trusted-base planner', () => {
    let invokedArgs: readonly string[] | undefined;
    const spawn: SpawnTargetedTests = (_command, args) => {
      invokedArgs = args;
      return { status: 0 };
    };
    const targets = [
      'server/tests/example.test.ts',
      'server/tests/dateWindowTimezone.test.ts',
    ];
    assert.equal(runTargetedServerTests(JSON.stringify(targets), spawn, () => true), 0);
    assert.deepEqual(invokedArgs, [
      'vitest', 'run', '--config', 'server/vitest.config.ts',
      ...targets, '--pool=threads', '--maxWorkers=1',
    ]);
  });

  it('rejects missing tests before launching Vitest', () => {
    let spawned = false;
    assert.throws(() => runTargetedServerTests(
      JSON.stringify(['server/tests/missing.test.ts']),
      () => {
        spawned = true;
        return { status: 1 };
      },
      () => false,
    ), /Selected server test does not exist: server\/tests\/missing\.test\.ts/);
    assert.equal(spawned, false);
  });

  it('rejects empty, traversal, malformed JSON, and non-test targets', () => {
    for (const value of [
      '[]',
      '[',
      '["server/tests/../secrets.test.ts"]',
      '["server/services/example.ts"]',
    ]) assert.throws(() => parseTargetedServerTests(value));
  });

  it('requires every selected test to execute nonempty passing assertions', () => {
    const targets = ['server/tests/example.integration.test.ts'];
    const report = (statuses: readonly string[]) => JSON.stringify({
      testResults: [{
        name: `/workspace/${targets[0]}`,
        assertionResults: statuses.map(status => ({ status })),
      }],
    });
    for (const statuses of [['passed'], ['passed', 'skipped'], ['passed', 'pending'], ['passed', 'todo']]) {
      assert.doesNotThrow(() => validateTargetedTestResults(targets, 'results.json', () => report(statuses)));
    }
    for (const statuses of [[], ['skipped'], ['failed'], ['passed', 'failed']]) {
      assert.throws(() => validateTargetedTestResults(targets, 'results.json', () => report(statuses)));
    }
  });

  it('requires every runtime persistence assertion to pass', () => {
    for (const target of [
      'server/tests/conversationRuntimeSql.integration.test.ts',
      'server/tests/profilePreparationDatabase.test.ts',
      'server/tests/durableChatPendingState.integration.test.ts',
    ]) {
      for (const status of ['skipped', 'pending', 'todo', 'failed']) {
        assert.throws(() => validateTargetedTestResults([target], 'results.json', () => JSON.stringify({
          testResults: [{
            name: `/workspace/${target}`,
            assertionResults: [{ status: 'passed' }, { status }],
          }],
        })), /Runtime database suite skipped or failed/);
      }
    }
  });
});
