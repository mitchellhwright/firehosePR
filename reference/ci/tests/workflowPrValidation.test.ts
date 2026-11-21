import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { test } from 'node:test';
import { load } from 'js-yaml';
import { z } from 'zod';

import { workflowDocument, workflowJob } from '../src/workflowStepShell.ts';
import { ciEventCondition, ciEventFieldWith } from '../workflows/lib/ciEvent.ts';

const stepSchema = z.object({
  name: z.string().optional(),
  uses: z.string().optional(),
  run: z.string().optional(),
  if: z.string().optional(),
  with: z.record(z.string(), z.unknown()).optional(),
}).passthrough();
const jobSchema = z.object({
  if: z.string().optional(),
  steps: z.array(stepSchema),
}).passthrough();

function job(workflow: string, id: string): z.infer<typeof jobSchema> {
  return jobSchema.parse(workflowJob(workflow, id));
}

test('draft PRs do not enter substantive validation or iOS verdicts', () => {
  const pr = z.object({ on: z.object({ pull_request: z.object({ types: z.array(z.string()) }) }) })
    .parse(workflowDocument('pr-checks.yml'));
  assert.deepEqual(pr.on.pull_request.types,
    ['opened', 'synchronize', 'reopened', 'ready_for_review']);
  // The ready guard is explicit per event: a draft PR waits, while a merge
  // queue candidate (which has no draft field) is always ready.
  const ready = ciEventCondition('ready');
  assert.ok(job('pr-checks.yml', 'plan-pr-validation').if?.includes(ready));
  assert.ok(job('pr-checks.yml', 'validate').if?.includes(ready));
  assert.ok(job('ios-tests.yml', 'ios-change-gate').if?.includes(ready));
  for (const id of ['test-ios', 'storekit-purchase-status', 'onboarding-e2e-status']) {
    assert.ok(job('ios-tests.yml', id).if
      ?.includes("inputs.test_scope != 'observability-credential-sync'"), id);
  }
});

test('dependency-backed PR jobs use the typed installer', () => {
  for (const id of [
    'server-static', 'server-process-tests', 'server-tests',
    'targeted-server-tests', 'ios-contracts', 'database-integration',
  ]) {
    const steps = job('pr-checks.yml', id).steps;
    assert.ok(steps.some((step) => step.run === 'node ci/src/actions/installNodeDependencies.ts'), id);
    assert.ok(!steps.some((step) => step.run?.startsWith('npm ci')), id);
    const setup = steps.filter((step) => step.uses?.startsWith('actions/setup-node@'));
    assert.ok(setup.length > 0, id);
  }
});

// setup-node's implicit npm cache stays off: it is keyed and scoped by the action,
// not by this repository. The one remote dependency cache is the exact-key
// node_modules restore the owner approved on 2026-09-27 (ci/src/nodeModulesCache.ts,
// contract in ci/tests/nodeModulesCache.test.ts): hosted lanes restore only, develop saves.
test('every setup-node action in the PR and iOS workflows disables implicit remote caches', () => {
  for (const name of ['pr-checks.yml', 'ios-tests.yml']) {
    const document = workflowDocument(name);
    const setups = Object.values(document.jobs).flatMap((value) => jobSchema.parse(value).steps)
      .filter((step) => step.uses?.startsWith('actions/setup-node@'));
    assert.ok(setups.length > 0, name);
    for (const step of setups) {
      assert.equal(step.with?.['package-manager-cache'], false, name);
      assert.equal(step.with?.['cache'], undefined, name);
    }
  }
});

test('large workflow command blocks pass GitHub context through env', () => {
  const limit = 21_000;
  const directory = new URL('../../.github/workflows/', import.meta.url);
  for (const name of readdirSync(directory).filter((entry) => /\.ya?ml$/.test(entry))) {
    const parsed = z.object({ jobs: z.record(z.string(), z.object({
      steps: z.array(stepSchema).optional(),
    }).passthrough()) }).parse(load(readFileSync(new URL(name, directory), 'utf8')));
    for (const [id, value] of Object.entries(parsed.jobs)) {
      for (const step of value.steps ?? []) {
        if ((step.run?.length ?? 0) <= limit) continue;
        assert.ok(!step.run?.includes('${{'), `${name}:${id}:${step.name} embeds an expression in a large run block`);
      }
    }
  }
});

test('PR validation uses an exact-event read-only checkout without PR-target elevation', () => {
  const document = z.object({
    on: z.record(z.string(), z.unknown()),
    permissions: z.record(z.string(), z.string()),
    concurrency: z.object({ group: z.string(), 'cancel-in-progress': z.boolean() }),
  }).parse(workflowDocument('pr-checks.yml'));
  assert.ok('pull_request' in document.on);
  assert.ok(!('pull_request_target' in document.on));
  assert.equal(document.concurrency.group, `pr-checks-\${{ ${ciEventFieldWith('prNumber', {
    merge_group: 'github.ref', workflow_dispatch: 'github.ref',
  }).expression} }}`);
  assert.equal(document.concurrency['cancel-in-progress'], true);
  assert.deepEqual(document.permissions,
    { actions: 'read', contents: 'read', 'pull-requests': 'read' });
  for (const id of [
    'validation-policy', 'workflow-contracts', 'server-static',
    'server-process-tests', 'server-tests', 'targeted-server-tests',
    'ios-contracts', 'database-integration',
  ]) {
    const checkout = job('pr-checks.yml', id).steps.find((step) =>
      step.name === 'Checkout the workflow revision');
    assert.ok(checkout, id);
    assert.match(checkout.uses ?? '', /^actions\/checkout@[a-f0-9]{40}$/);
    assert.equal(checkout.with?.['persist-credentials'], false, id);
    assert.equal(checkout.with?.['ref'], undefined, id);
  }
});

test('promotion checkpoint runs typed transaction from main with a bounded App token', () => {
  const document = z.object({
    on: z.record(z.string(), z.unknown()),
    permissions: z.record(z.string(), z.string()),
    concurrency: z.object({ group: z.string(), 'cancel-in-progress': z.boolean() }),
  }).parse(workflowDocument('promotion-checkpoint.yml'));
  assert.ok('pull_request_target' in document.on);
  assert.equal(document.concurrency.group, 'promotion-checkpoint-main');
  assert.equal(document.concurrency['cancel-in-progress'], false);
  assert.ok(Object.values(document.permissions).every((permission) => permission !== 'write'));
  const transaction = z.object({
    if: z.string(), 'timeout-minutes': z.number(),
    permissions: z.record(z.string(), z.string()).optional(),
  })
    .parse(workflowJob('promotion-checkpoint.yml', 'checkpoint'));
  assert.ok(Object.values(transaction.permissions ?? {}).every((permission) => permission !== 'write'));
  assert.equal(transaction.permissions?.contents ?? document.permissions.contents, 'read');
  assert.ok(transaction.if.includes("github.event.pull_request.head.ref == 'develop'"));
  assert.ok(transaction.if.includes("github.event.pull_request.base.ref == 'main'"));
  assert.equal(transaction['timeout-minutes'], 10);
  const steps = job('promotion-checkpoint.yml', 'checkpoint').steps;
  const index = (name: string): number => steps.findIndex((step) => step.name === name);
  assert.ok(index('Install typed promotion transaction dependencies')
    < index('Create promotion GitHub App token'));
  assert.match(steps[index('Create promotion GitHub App token')]?.uses ?? '',
    /^actions\/create-github-app-token@[a-f0-9]{40}$/);
  assert.equal(steps.find((step) => step.name === 'Create immutable checkpoint pull request')?.run,
    'node ci/src/actions/createPromotionCheckpoint.ts');
  assert.equal(steps.find((step) => step.name === 'Summarize promotion checkpoint')?.run,
    'node ci/src/actions/summarizePromotionCheckpoint.ts');
  const checkout = steps.find((step) => step.name === 'Check out the checkpoint transaction');
  assert.ok(checkout);
  assert.equal(checkout.with?.['persist-credentials'], false);
  assert.equal(checkout.with?.['ref'], undefined);
  assert.equal(checkout.with?.['repository'], undefined);
  assert.ok(!steps.some((step) => step.run?.includes('scripts/ci/promotion-checkpoint/checkpoint/')));
});

test('validation policy fetches candidate history for debt preflight and preserves artifact fallback', () => {
  const policy = z.object({
    needs: z.array(z.string()),
    if: z.string(),
    steps: z.array(stepSchema),
  }).parse(workflowJob('pr-checks.yml', 'validation-policy'));
  assert.deepEqual(policy.needs, ['plan-pr-validation']);
  assert.match(policy.if,
    /^needs\.plan-pr-validation\.outputs\.metadata_only != 'true'.*policy_required == 'true'$/);
  const checkout = policy.steps.find((step) => step.uses?.startsWith('actions/checkout@'));
  assert.ok(checkout);
  assert.equal(checkout.with?.['fetch-depth'], 1);
  const preflight = policy.steps.find((step) => step.name === 'Validate debt dependency preflight');
  assert.ok(preflight);
  assert.deepEqual(preflight.with, { entry: 'ci/src/actions/debt/runDebtDependencyPreflight.ts' });
  const entry = readFileSync(new URL('../src/actions/debt/runDebtDependencyPreflight.ts',
    import.meta.url), 'utf8');
  assert.match(entry, /ensurePolicyHistory\(process\.cwd\(\)/);
  assert.match(entry, /'--event-path', eventPath/);
  assert.match(entry, /mergeGroup === undefined \? required\('GITHUB_EVENT_PATH'\)/);
  const retain = policy.steps.find((step) => step.name === 'Retain debt dependency evidence');
  assert.ok(retain);
  assert.equal(retain.if, "always() && steps.debt-preflight.outcome == 'failure'");
  assert.equal(retain.id, 'upload-debt-preflight');
  assert.equal(retain['continue-on-error'], true);
  const preserve = policy.steps.find((step) =>
    step.name === 'Preserve debt evidence when artifact storage is unavailable');
  assert.ok(preserve);
  assert.match(preserve.if ?? '', /steps\.upload-debt-preflight\.outcome == 'failure'/);
  assert.deepEqual(preserve.with, { entry: 'ci/src/actions/debt/preserveDebtEvidence.ts' });
  assert.equal(policy.steps.filter((step) => step['continue-on-error'] !== undefined).length, 1);
  assert.doesNotMatch(JSON.stringify(policy), /pull_request\.body/);
});
