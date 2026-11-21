import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import test from 'node:test';
import { resolve } from 'node:path';

import { selectChecks } from '../src/checkRunner.ts';
import {
  typedWorkflowContractTests,
  workflowContractTests,
  workflowContractTestSet,
} from '../src/workflowContractTests.ts';
import { prChecks } from '../workflows/pr-checks.ts';

test('typed workflow contracts are selected and executed by one inventory', () => {
  assert.deepEqual(workflowContractTests, typedWorkflowContractTests);
  assert.equal(workflowContractTestSet.size, typedWorkflowContractTests.length);
  for (const path of typedWorkflowContractTests) {
    assert.ok(existsSync(resolve(path)), `workflow contract does not exist: ${path}`);
    assert.ok(workflowContractTestSet.has(path), `workflow contract is not selectable: ${path}`);
  }
});

test('workflow contract suites run exactly once, through ci:check', () => {
  const job = prChecks.config.jobs.find((candidate) => candidate.id === 'workflow-contracts');
  assert.ok(job);
  const commands = job.config.steps.map((step) => step.config.command);
  assert.equal(commands.filter((command) => command === 'npm run ci:check -- --workflow-contracts').length, 1);
  for (const command of commands) {
    assert.ok(command === undefined || !/\bnode --test\b|ci\/tests\//.test(command),
      `the job runs a ci/tests suite outside ci:check, which already runs it: ${command}`);
  }

  const manifest = JSON.parse(readFileSync('package.json', 'utf8')) as {
    readonly scripts: Readonly<Record<string, string>>;
  };
  assert.equal(selectChecks(manifest).filter((script) => script === 'ci:test').length, 1);
  assert.equal(
    manifest.scripts['ci:test'],
    'node --import ./ci/tests/hermeticGithubEvent.ts --test ci/tests/*.test.ts',
  );
  const coveredByCiTest = /^ci\/tests\/[^/]+\.test\.ts$/;
  for (const path of [...typedWorkflowContractTests, 'ci/tests/prepareLocalGcpAdc.test.ts']) {
    assert.ok(coveredByCiTest.test(path), `${path} is outside the ci:test glob`);
    assert.ok(existsSync(resolve(path)), `${path} does not exist`);
  }
});
