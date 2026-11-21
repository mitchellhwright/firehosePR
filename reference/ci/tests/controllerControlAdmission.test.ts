import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { load } from 'js-yaml';
import { z } from 'zod';
import { evaluateExpression, type ExpressionValue } from './fixtures/actionsExpression.ts';
import { hostedLinuxRunnerLabels, trustedControlLinuxRunnerLabels } from '../src/runnerPolicy.ts';

const schema = z.object({ jobs: z.record(z.string(), z.object({
  if: z.string().optional(), 'runs-on': z.string(), needs: z.array(z.string()).optional(),
  'timeout-minutes': z.number(), permissions: z.record(z.string(), z.string()),
  steps: z.array(z.object({ with: z.record(z.string(), z.unknown()).optional(),
    run: z.string().optional(), env: z.record(z.string(), z.unknown()).optional() })).optional(),
})) });
const jobs = schema.parse(load(readFileSync('.github/workflows/refresh-pr-ci-after-base-edit.yml', 'utf8'))).jobs;
const route = jobs['route-initial-control'];
assert.ok(route);
const evaluate = (text: string, context: Record<string, ExpressionValue>) =>
  evaluateExpression(text, context);
const context = (event: string, enabled: string, labels?: readonly string[]) => ({
  github: { event_name: event, repository: 'example-org/example-app', event: {
    repository: { default_branch: 'develop' },
    pull_request: { head: { repo: { full_name: 'example-org/example-app' } } },
  } }, vars: { CI_HOSTED_LINUX_AVAILABLE: enabled },
  needs: { 'route-initial-control': { outputs: { control_runner_labels: labels ? JSON.stringify(labels) : '' } } },
});

test('continuity admission is bounded, read-only and executes only default-branch code', () => {
  assert.equal(route['timeout-minutes'], 5);
  assert.deepEqual(route.permissions, { actions: 'read', contents: 'read' });
  assert.equal(route.steps?.[0]?.with?.ref, '${{ github.event.repository.default_branch }}');
  assert.equal(route.steps?.[0]?.with?.['persist-credentials'], false);
  assert.equal(route.steps?.at(-1)?.run, 'node ci/src/actions/selectControlRunners.ts');
  assert.equal(route.steps?.at(-1)?.env?.SAME_REPOSITORY_CODE, '${{ true }}');
});

test('push, workflow completion and same-repository PR events honor hosted admission policy', () => {
  for (const event of ['push', 'workflow_run', 'pull_request_target']) {
    assert.deepEqual(evaluate(route['runs-on'], context(event, '1')), hostedLinuxRunnerLabels);
    assert.deepEqual(evaluate(route['runs-on'], context(event, '0')), trustedControlLinuxRunnerLabels);

  }
  const fork = context('pull_request_target', '1');
  fork.github.event.pull_request.head.repo.full_name = 'fork/example-app';
  assert.equal(evaluate(route.if ?? '', fork), false);
});

test('every continuity controller consumes admission without changing conflict dependencies', () => {
  for (const [id, job] of Object.entries(jobs)) {
    if (id === 'route-initial-control') continue;
    assert.ok(job.needs?.includes('route-initial-control'), id);
    for (const event of ['push', 'workflow_run', 'pull_request_target']) {
      assert.deepEqual(evaluate(job['runs-on'], context(event, '1')), trustedControlLinuxRunnerLabels, `${id}: unreadable route`);
      for (const labels of [trustedControlLinuxRunnerLabels, hostedLinuxRunnerLabels]) {
        assert.deepEqual(evaluate(job['runs-on'], context(event, '1', labels)), labels, id);
      }
    }
  }
  assert.deepEqual(jobs['cancel-conflicted-pr-ci']?.needs,
    ['route-initial-control', 'fan-out-base-update', 'cancel-obsolete-ios']);
});


test('admission skips no-op events and shares the actual controller predicates', () => {
  const scenarios: readonly { event_name: string; event: Record<string, ExpressionValue> }[] = [
    { event_name: 'push', event: {} },
    { event_name: 'pull_request_target', event: { action: 'edited' } },
    { event_name: 'pull_request_target', event: { action: 'synchronize' } },
    { event_name: 'pull_request_target', event: { action: 'ready_for_review' } },
    { event_name: 'pull_request_target', event: { action: 'edited', changes: { base: {} }, pull_request: { draft: false, head: { repo: { full_name: 'example-org/example-app' } } } } },
    { event_name: 'workflow_run', event: { workflow_run: { name: 'Test - iOS', event: 'pull_request', conclusion: 'success', head_sha: 'a', pull_requests: [{ head: { sha: 'a' } }] } } },
    { event_name: 'workflow_run', event: { workflow_run: { name: 'Test - iOS', event: 'pull_request', conclusion: 'failure', head_sha: 'a', pull_requests: [{ head: { sha: 'a' } }], head_commit: { committer: { email: 'noreply@github.com' } } } } },
    { event_name: 'workflow_run', event: { workflow_run: { path: '.github/workflows/ios-tests.yml', event: 'workflow_dispatch', conclusion: 'success', head_branch: 'develop', display_title: 'promotion-evidence:123' } } },
  ];
  const producers = ['fan-out-base-update', 'cancel-obsolete-ios', 'resume-retained-ios', 'recheck-promotion-after-evidence'];
  for (const scenario of scenarios) {
    const base = context(scenario.event_name, '1');
    const scope = { ...base, github: { ...base.github, ...scenario,
      event: { ...base.github.event, ...scenario.event } } };
    const required = producers.some(id => Boolean(evaluate(jobs[id]?.if ?? '', scope)));
    assert.equal(Boolean(evaluate(route.if ?? '', scope)), required, JSON.stringify(scenario));
  }
  const edit = context('pull_request_target', '1');
  assert.equal(evaluate(route.if ?? '', edit), false);
  const success = { ...context('workflow_run', '1'), github: { event_name: 'workflow_run', event: {
    workflow_run: { name: 'Test - iOS', event: 'pull_request', conclusion: 'success', head_sha: 'a', pull_requests: [{ head: { sha: 'a' } }] },
  } } };
  assert.equal(Boolean(evaluate(route.if ?? '', success)), false);
});

// Model native job-level dependency gating: GitHub inserts success() only when no status function is present.
function eligible(condition: string, scope: Record<string, ExpressionValue>, failed: boolean, cancelled: boolean) {
  const status = { success: !failed, failure: failed, cancelled };
  const hasStatus = /\b(?:always|success|failure|cancelled)\s*\(/.test(condition);
  return (!failed || hasStatus) && Boolean(evaluateExpression(condition, scope, status));
}

test('failed admission preserves eligible controllers while cancellation stops new work', () => {
  const producer = jobs['fan-out-base-update'];
  assert.ok(producer?.if);
  const scope = context('push', '1');
  for (const failed of [false, true]) {
    assert.equal(eligible(producer.if, scope, failed, false), true);
    assert.deepEqual(evaluate(producer['runs-on'], scope), trustedControlLinuxRunnerLabels);
    assert.equal(eligible(producer.if, scope, failed, true), false);
  }
  for (const id of ['cancel-obsolete-ios', 'resume-retained-ios', 'recheck-promotion-after-evidence']) {
    assert.match(jobs[id]?.if ?? '', /^always\(\) && !cancelled\(\)/, id);
  }
});

const iosDocument = z.object({ jobs: z.record(z.string(), z.unknown()) }).parse(load(readFileSync('.github/workflows/ios-tests.yml', 'utf8')));
const iosJobs = schema.parse({ jobs: Object.fromEntries(['route-initial-control', 'ios-change-gate'].map(id => [id, iosDocument.jobs[id]])) }).jobs;
test('iOS planning admits Linux overflow with trusted code and survives failed admission', () => {
  const admission = iosJobs['route-initial-control'];
  const gate = iosJobs['ios-change-gate'];
  assert.ok(admission && gate?.if);
  assert.equal(admission.steps?.[0]?.with?.ref, '${{ github.event.repository.default_branch }}');
  assert.equal(admission.steps?.[0]?.with?.['persist-credentials'], false);
  const scope = context('pull_request', '1');
  assert.deepEqual(evaluate(admission['runs-on'], scope), hostedLinuxRunnerLabels);
  assert.equal(eligible(gate.if, scope, true, false), true);
  assert.deepEqual(evaluate(gate['runs-on'], scope), trustedControlLinuxRunnerLabels);
  assert.deepEqual(evaluate(gate['runs-on'], context('pull_request', '1', hostedLinuxRunnerLabels)), hostedLinuxRunnerLabels);
  assert.equal(eligible(gate.if, scope, true, true), false);
  const fork = context('pull_request', '0');
  fork.github.event.pull_request.head.repo.full_name = 'fork/example-app';
  assert.deepEqual(evaluate(admission['runs-on'], fork), hostedLinuxRunnerLabels);
  assert.deepEqual(evaluate(gate['runs-on'], fork), hostedLinuxRunnerLabels);
  const noPlanning = { ...scope, inputs: { test_scope: 'observability-credential-sync' } };
  assert.equal(evaluate(admission.if ?? '', noPlanning), false);
  assert.equal(eligible(gate.if, noPlanning, true, false), false);
});
