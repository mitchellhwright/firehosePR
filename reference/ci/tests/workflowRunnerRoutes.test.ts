import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { z } from 'zod';

import { dispatchRunnerMaintenance, parseMaintenanceDispatchInputs } from '../src/actions/dispatchRunnerMaintenance.ts';
import { validateMaintenanceDispatchRef } from '../src/actions/validateMaintenanceDispatchRef.ts';
import { stepEnvironment, stepShell, workflowDocument, workflowJob } from '../src/workflowStepShell.ts';
import { ciEventFieldSource } from '../workflows/lib/ciEvent.ts';

const stepSchema = z.object({
  name: z.string().optional(),
  run: z.string().optional(),
  if: z.string().optional(),
  env: z.record(z.string(), z.string()).optional(),
}).passthrough();
const jobSchema = z.object({
  'runs-on': z.union([z.string(), z.array(z.string()), z.record(z.string(), z.unknown())]),
  permissions: z.record(z.string(), z.string()).optional(),
  steps: z.array(stepSchema),
}).passthrough();

function job(workflow: string, id: string): z.infer<typeof jobSchema> {
  return jobSchema.parse(workflowJob(workflow, id));
}

function step(workflow: string, id: string, name: string): z.infer<typeof stepSchema> {
  const found = job(workflow, id).steps.find((candidate) => candidate.name === name);
  assert.ok(found, `${workflow}:${id} lacks ${name}`);
  return found;
}

test('runner maintenance dispatch uses dedicated control and exact-host execution', () => {
  const fleet = workflowDocument('install-runner-cleanup-hooks.yml');
  const host = workflowDocument('install-runner-cleanup-host.yml');
  const completion = workflowDocument('runner-activation-complete.yml');
  assert.deepEqual(job('install-runner-cleanup-hooks.yml', 'reconcile-host')['runs-on'],
    ['self-hosted', 'Linux', 'example-trusted-control']);
  assert.equal(step('install-runner-cleanup-hooks.yml', 'reconcile-host',
    'Dispatch isolated exact-host maintenance').run,
  'node ci/src/actions/dispatchRunnerMaintenance.ts');
  assert.ok(!job('install-runner-cleanup-hooks.yml', 'reconcile-host').steps.some((item) =>
    item.uses === './.github/workflows/install-runner-cleanup-host.yml'));
  assert.ok(z.object({ on: z.object({ workflow_dispatch: z.unknown() }) })
    .safeParse(host).success);
  assert.ok(z.object({ on: z.object({ repository_dispatch: z.unknown() }) })
    .safeParse(completion).success);
  assert.deepEqual(job('runner-activation-complete.yml', 'activation-complete')['runs-on'],
    ['self-hosted', '${{ github.event.client_payload.host_label }}']);
  for (const document of [fleet, host, completion]) {
    for (const value of Object.values(document.jobs)) {
      const route = jobSchema.parse(value)['runs-on'];
      assert.doesNotMatch(JSON.stringify(route), /ubuntu-slim|ubuntu-latest/);
    }
  }
  for (const source of [
    stepShell('install-runner-cleanup-hooks.yml', 'reconcile-host',
      'Dispatch isolated exact-host maintenance'),
    stepShell('runner-activation-complete.yml', 'activation-complete',
      'Confirm the exact activation this listener serves'),
  ]) assert.doesNotMatch(source, /cancel-unassigned|permission-organization-self-hosted-runners/);
});

test('native maintenance push filtering ignores dispatcher-only updates and keeps installed-host inputs', () => {
  const trigger = z.object({
    on: z.object({
      workflow_dispatch: z.unknown(),
      push: z.object({ branches: z.array(z.string()), paths: z.array(z.string()) }),
    }),
  }).parse(workflowDocument('install-runner-cleanup-hooks.yml')).on;
  assert.deepEqual(trigger.push.branches, ['develop', 'main']);
  assert.ok(trigger.push.paths.every((path) => !path.includes('*')));
  const triggers = (changed: readonly string[]) => changed.some((path) => trigger.push.paths.includes(path));
  // #6527 performed seven host installs after changing only ref validation
  // and Xcode Cloud tag preflight; no installed host program changed.
  assert.equal(triggers([
    '.github/workflows/install-runner-cleanup-hooks.yml',
    '.github/workflows/xcode-cloud-build-tags.yml',
    'ci/src/actions/validateMaintenanceDispatchRef.ts',
    'ci/src/actions/validateAppStoreConnectConfiguration.ts',
    'scripts/ci/xcode-cloud-build-tags/reconcile/validate-app-store-connect-configuration.sh',
  ]), false);
  assert.equal(triggers(['ci/src/actions/dispatchRunnerMaintenance.ts']), false);
  for (const input of [
    'ci/src/maintainedRunnerHosts.ts', '.github/workflows/install-runner-cleanup-host.yml',
    'ci/src/runnerHooks/jobCompleted.ts', 'ci/src/actions/installJobCompletedHook.ts',
    'scripts/setup-github-macos-runner.sh', 'scripts/setup-github-linux-runner.sh',
    'scripts/provision-github-macos-runner-tools.sh',
    'scripts/activate-github-actions-runner-environment.sh',
  ]) assert.equal(triggers([input]), true, input);
});

test('maintenance dispatcher sends one exact-host GitHub workflow dispatch', async () => {
  const requests: Array<{ path: string; payload: unknown }> = [];
  const decision = await dispatchRunnerMaintenance({
    repository: 'example-org/example-app', ref: 'develop', hostLabel: 'ios-host-tg1',
    platform: 'macos', auditOnly: false, runId: '12345', runAttempt: '2',
  }, async (path, payload) => { requests.push({ path, payload }); });
  assert.deepEqual(requests, [{
    path: '/repos/example-org/example-app/actions/workflows/install-runner-cleanup-host.yml/dispatches',
    payload: {
      ref: 'develop',
      inputs: {
        host_label: 'ios-host-tg1', platform: 'macos', audit_only: 'false',
        correlation_id: '12345-2-ios-host-tg1',
      },
    },
  }]);
  assert.deepEqual(decision, {
    exitCode: 0,
    messages: [{ level: 'info', text: 'Dispatched runner maintenance for ios-host-tg1 as 12345-2-ios-host-tg1.' }],
  });
  await assert.rejects(dispatchRunnerMaintenance({
    repository: 'example-org/example-app', ref: 'main', hostLabel: 'ios-host-tg1',
    platform: 'macos', auditOnly: true, runId: '12345', runAttempt: '3',
  }, async () => { throw new Error('GitHub refused the dispatch'); }),
  /GitHub refused the dispatch/);
});

test('maintenance environment rejects invalid refs, host capabilities, booleans and run identities', () => {
  const valid = {
    repository: 'example-org/example-app', ref: 'develop', hostLabel: 'ios-host-tg1',
    platform: 'macos', auditOnly: 'false', runId: '12345', runAttempt: '2',
  };
  assert.deepEqual(parseMaintenanceDispatchInputs(valid), { ...valid, auditOnly: false });
  for (const invalid of [
    { ref: 'feature/untrusted' }, { hostLabel: 'unknown-host' }, { platform: 'linux' },
    { auditOnly: 'yes' }, { runId: '0' }, { runAttempt: '1/2' }, { repository: '../dispatches' },
  ]) assert.throws(() => parseMaintenanceDispatchInputs({ ...valid, ...invalid }), /Runner maintenance/);
});

test('host maintenance accepts only protected develop or main', () => {
  const host = z.object({ if: z.string() })
    .parse(workflowJob('install-runner-cleanup-host.yml', 'install'));
  assert.equal(host.if,
    "github.ref == 'refs/heads/develop' || github.ref == 'refs/heads/main'");
});

test('fleet maintenance rejects unsupported refs inside its dispatcher job', () => {
  const dispatcher = workflowJob('install-runner-cleanup-hooks.yml', 'reconcile-host');
  assert.ok(!('if' in dispatcher), 'an invalid dispatch must fail visibly');
  assert.equal(step('install-runner-cleanup-hooks.yml', 'reconcile-host',
    'Validate maintenance dispatch ref').run,
  'node ci/src/actions/validateMaintenanceDispatchRef.ts');
  assert.match(String(step('install-runner-cleanup-hooks.yml', 'reconcile-host',
    'Set up Node for typed maintenance').uses), /^actions\/setup-node@/);
  assert.equal(stepEnvironment('install-runner-cleanup-hooks.yml', 'reconcile-host',
    'Validate maintenance dispatch ref')['DISPATCH_REF'], '${{ github.ref }}');
  for (const ref of ['refs/heads/develop', 'refs/heads/main']) {
    const decision = validateMaintenanceDispatchRef(ref);
    assert.equal(decision.exitCode, 0, ref);
    assert.deepEqual(decision.messages, [{
      level: 'info', text: `Runner maintenance dispatch accepted from ${ref}.`,
    }]);
  }
  for (const ref of [undefined, '', 'refs/heads/feature/unsafe-maintenance', 'refs/tags/main']) {
    const decision = validateMaintenanceDispatchRef(ref);
    assert.equal(decision.exitCode, 1, String(ref));
    assert.deepEqual(decision.messages, [{
      level: 'error', text: 'Runner maintenance requires a trusted develop or main ref.',
    }]);
  }
});

test('detached activation uses a bounded App token and guarded revocation', () => {
  const token = step('install-runner-cleanup-host.yml', 'install',
    'Create bounded runner activation handoff token');
  const tokenConfig = z.object({ with: z.record(z.string(), z.unknown()) }).parse(token);
  assert.equal(tokenConfig.with['permission-contents'], 'write');
  assert.equal(tokenConfig.with['skip-token-revoke'], true);
  const environment = stepEnvironment('install-runner-cleanup-host.yml', 'install',
    'Install completed-job cleanup hook');
  assert.equal(environment.GITHUB_TOKEN_VALUE, '${{ steps.activation-token.outputs.token }}');
  assert.notEqual(environment.GITHUB_TOKEN_VALUE, '${{ github.token }}');
  const revoke = stepShell('install-runner-cleanup-host.yml', 'install',
    'Revoke unhanded activation token');
  assert.match(revoke, /for attempt in 1 2 3/);
  assert.match(revoke, /gh api --method DELETE \/installation\/token/);
  assert.match(revoke, /if \[ "\$attempt" -eq 3 \]/);
  assert.match(revoke, /token_claim_dir="\$\{token_file\}\.claim"/);
  assert.match(revoke, /if ! mkdir "\$token_claim_dir"/);
  assert.doesNotMatch(revoke, /if \[ -f "\$accepted_marker" \]/);
  const activation = readFileSync(
    new URL('../../scripts/activate-github-actions-runner-environment.sh', import.meta.url), 'utf8');
  assert.match(activation, /token_claim_dir="\$\{completion_token_file\}\.claim"/);
  assert.match(activation, /if ! mkdir "\$token_claim_dir"/);
});

test('PR validation uses Linux routes without a retired macOS resolver', () => {
  const document = workflowDocument('pr-checks.yml');
  assert.equal(document.jobs['resolve-pr-validation-runner'], undefined);
  for (const id of ['validate', 'database-integration']) {
    const route = job('pr-checks.yml', id)['runs-on'];
    assert.doesNotMatch(JSON.stringify(route), /macOS|ios-capacity-24gb|pr_validation_runner_labels/);
  }
  assert.doesNotMatch(JSON.stringify(document.jobs), /PR_VALIDATE_RUNNER_LABELS/);
});

test('iOS resolver runs only for required work with fork-safe read permissions', () => {
  const document = z.object({ permissions: z.record(z.string(), z.string()) })
    .parse(workflowDocument('ios-tests.yml'));
  assert.deepEqual(document.permissions, {
    actions: 'read', contents: 'read', 'pull-requests': 'read',
  });
  const resolver = step('ios-tests.yml', 'ios-change-gate', 'Resolve iOS macOS runner labels');
  for (const condition of [
    "steps.precheck.outputs.production_promotion == 'true'",
    'steps.detect.outputs.should_run',
    "steps.base-update.outputs.deferred != 'true'",
  ]) assert.ok(resolver.if?.includes(condition));
  assert.equal(resolver.run, 'node ci/src/actions/ios/resolveIosRunnerLabels.ts');
  const environment = stepEnvironment('ios-tests.yml', 'ios-change-gate',
    'Resolve iOS macOS runner labels');
  assert.equal(environment.EVENT_NAME, '${{ github.event_name }}');
  assert.equal(environment.HEAD_REPOSITORY,
    `\${{ ${ciEventFieldSource('headRepository')} }}`);
  assert.ok(!('IOS_HOSTED_MACOS_RUNNER_LABELS' in environment));
  assert.ok(!('IOS_FORCE_HOSTED_MAC_RUNNER' in environment));

  const execution = job('ios-tests.yml', 'test-ios-execution');
  assert.deepEqual(execution.permissions, {
    actions: 'read', contents: 'read', 'pull-requests': 'read',
  });
  assert.equal(workflowDocument('ios-tests.yml').jobs['approve-develop-onboarding-e2e'], undefined);
  assert.ok(!String(execution.if).includes('approve-develop-onboarding-e2e'));
});

test('Actions storage cleanup is scheduled on control without iOS-run contention', () => {
  const document = z.object({
    on: z.object({ schedule: z.array(z.unknown()), workflow_dispatch: z.unknown() }),
    permissions: z.record(z.string(), z.string()),
    concurrency: z.object({ group: z.string() }),
  }).parse(workflowDocument('actions-artifact-cleanup.yml'));
  assert.ok(document.on.schedule.length > 0);
  assert.equal(document.permissions.actions, 'write');
  assert.equal(document.concurrency.group, 'actions-storage-cleanup');
  assert.deepEqual(job('actions-artifact-cleanup.yml', 'prune-superseded-caches')['runs-on'],
    ['self-hosted', 'Linux', 'example-trusted-control']);
  const cleanup = step('actions-artifact-cleanup.yml', 'prune-superseded-caches',
    'Prune superseded debt-card XCTest caches');
  assert.equal(cleanup.run, 'node ci/src/actions/cleanupActionsStorage.ts');
  assert.equal(cleanup.env?.CACHE_KEY_PREFIX, 'ios-debt-card-test-products-v1-');
  const triggers = z.object({ on: z.record(z.string(), z.unknown()) })
    .parse(workflowDocument('actions-artifact-cleanup.yml')).on;
  assert.ok(!('workflow_run' in triggers));
});
