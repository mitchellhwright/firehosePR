import assert from 'node:assert/strict';
import { spawnSync, type SpawnSyncReturns } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { load } from 'js-yaml';
import { z } from 'zod';
import { evaluateExpression } from './fixtures/actionsExpression.ts';

const stepSchema = z.object({
  name: z.string().optional(),
  id: z.string().optional(),
  run: z.string().optional(),
  uses: z.string().optional(),
  if: z.string().optional(),
  env: z.record(z.string(), z.unknown()).optional(),
  with: z.record(z.string(), z.unknown()).optional(),
  'continue-on-error': z.boolean().optional(),
  'working-directory': z.string().optional(),
}).passthrough();
const jobSchema = z.object({
  steps: z.array(stepSchema).optional(),
  needs: z.array(z.string()).optional(),
  if: z.string().optional(),
  'runs-on': z.unknown().optional(),
}).passthrough();
const workflowSchema = z.object({
  on: z.unknown(),
  jobs: z.record(z.string(), jobSchema),
}).passthrough();

type Job = z.infer<typeof jobSchema>;
type Step = z.infer<typeof stepSchema>;

const workflow = workflowSchema.parse(load(readFileSync(
  new URL('../../.github/workflows/ios-tests.yml', import.meta.url), 'utf8',
)));
const jobs = workflow.jobs;
const revisionVerifier = 'server/scripts/verifyDevE2eSchemaRevision.ts';
const objectVerifier = 'server/scripts/verifyPlaidSchedulerSchema.ts';
const nonE2eMacJobs = new Set([
  'verify-ios-release-archive',
  'build-ios-native-test-products',
  'test-ios-execution',
]);

function job(name: string): Job {
  const value = jobs[name];
  assert.ok(value, `${name} is missing`);
  return value;
}

function steps(name: string): readonly Step[] {
  const value = job(name).steps;
  assert.ok(value, `${name} has no steps`);
  return value;
}

function step(name: string, stepName: string): Step {
  const value = steps(name).find((candidate) => candidate.name === stepName);
  assert.ok(value, `${name} has no ${stepName} step`);
  return value;
}

function commands(value: Job): readonly string[] {
  return (value.steps ?? []).map((candidate) => candidate.run ?? '');
}

function physicalMacJobs(candidateJobs: Readonly<Record<string, Job>>): string[] {
  const selected = Object.entries(candidateJobs).filter(([, candidate]) => {
    const route = z.object({ labels: z.array(z.string()) }).safeParse(candidate['runs-on']);
    if (route.success) return ['self-hosted', 'macOS', 'ios-xcode']
      .every((label) => route.data.labels.includes(label));
    const dynamic = z.object({ labels: z.string() }).safeParse(candidate['runs-on']);
    const labels = dynamic.success ? dynamic.data.labels
      : typeof candidate['runs-on'] === 'string' ? candidate['runs-on'] : '';
    return labels.startsWith('${{ fromJson(')
      && labels.includes('["self-hosted","macOS","ios-xcode"]')
      && labels.includes('["self-hosted","macOS","ios-reserved-mitchell"]');
  });
  for (const [name, candidate] of selected) {
    if (nonE2eMacJobs.has(name)) continue;
    assert.ok(candidate.needs?.includes('prepare-dev-e2e-schema'),
      `${name} must not run before the development schema gate`);
    assert.match(candidate.if ?? '', /needs\.prepare-dev-e2e-schema\.result == 'success'/,
      `${name} must require successful schema verification`);
  }
  for (const name of nonE2eMacJobs) {
    assert.ok(selected.some(([candidate]) => candidate === name), `${name} allowlist entry is stale`);
  }
  return selected.map(([name]) => name);
}

describe('development E2E schema workflow contract', () => {
  it('checks revision parity before object drift and enforces both outcomes', () => {
    const schemaSteps = steps('prepare-dev-e2e-schema');
    const revisionIndex = schemaSteps.findIndex((candidate) =>
      candidate.run?.includes(revisionVerifier));
    const objectIndex = schemaSteps.findIndex((candidate) =>
      candidate.run?.includes(objectVerifier));
    assert.ok(revisionIndex >= 0 && objectIndex > revisionIndex);

    const revision = step('prepare-dev-e2e-schema', 'Verify development E2E schema revision');
    const objects = step('prepare-dev-e2e-schema', 'Verify development E2E schema objects');
    const verdict = step('prepare-dev-e2e-schema', 'Enforce development E2E schema verification');
    assert.equal(revision.id, 'schema-revision');
    assert.equal(revision['continue-on-error'], true);
    assert.equal(objects.id, 'schema-objects');
    assert.equal(objects['continue-on-error'], true);
    assert.match(objects.if ?? '', /!cancelled\(\)/);
    assert.match(verdict.if ?? '', /!cancelled\(\)/);
    assert.equal(verdict.env?.['REVISION_OUTCOME'], '${{ steps.schema-revision.outcome }}');
    assert.equal(verdict.env?.['OBJECT_OUTCOME'], '${{ steps.schema-objects.outcome }}');
    assert.match(verdict.run ?? '', /enforceDevE2eSchemaVerification\.ts$/);

    const manifests = schemaSteps.flatMap((candidate) => {
      const value = candidate.env?.['E2E_REQUIRED_MIGRATIONS_MANIFEST'];
      return value === undefined ? [] : [value];
    });
    assert.deepEqual(manifests, Array(2).fill(
      '${{ runner.temp }}/example-e2e-required-migrations-${{ github.run_id }}.json',
    ));
  });

  it('offers the manual diagnostic while leaving native and real-server lanes unselected', () => {
    const dispatch = z.object({
      workflow_dispatch: z.object({
        inputs: z.object({ test_scope: z.object({ options: z.array(z.string()) }) }),
      }),
    }).parse(workflow.on);
    assert.ok(dispatch.workflow_dispatch.inputs.test_scope.options.includes('development-e2e-schema'));
    assert.match(step('ios-change-gate', 'Precheck iOS Gate').run ?? '',
      /^node [\w./-]*ci\/src\/actions\/ios\/precheckIosGate\.ts$/);
    assert.match(job('prepare-dev-e2e-schema').if ?? '',
      /inputs\.test_scope == 'development-e2e-schema'/);
  });

  it('runs all three typed status aggregates for trusted diagnostics and rejects other refs', () => {
    const aggregates = [
      step('test-ios', 'Verify iOS test lanes'),
      step('test-ios', 'Verify onboarding execution result'),
      step('onboarding-e2e-status', 'Verify onboarding execution result'),
    ];
    const repositoryRoot = fileURLToPath(new URL('../..', import.meta.url));
    for (const aggregate of aggregates) {
      const invocation = /^node ([\w./-]+\.ts)$/.exec(aggregate.run ?? '');
      assert.ok(invocation, `${aggregate.name} must invoke one typed action`);
      const program = invocation[1];
      assert.ok(program);
      for (const [dispatchRef, expectedStatus] of [
        ['refs/heads/develop', 0], ['refs/heads/feature', 1],
      ] as const) {
        const result: SpawnSyncReturns<string> = spawnSync(process.execPath, [program], {
          encoding: 'utf8',
          cwd: repositoryRoot,
          env: {
            ...process.env,
            STATUS_AGGREGATE: String(aggregate.env?.['STATUS_AGGREGATE'] ?? ''),
            DISPATCH_REF: dispatchRef,
            EVENT_NAME: 'workflow_dispatch',
            TEST_SCOPE: 'development-e2e-schema',
          },
        });
        assert.equal(result.status, expectedStatus, `${aggregate.name} from ${dispatchRef}`);
        if (expectedStatus === 1) {
          assert.match(result.stdout, /requires a trusted develop or main ref/);
        }
      }
    }
  });

  it('requires schema parity wherever database objects are verified', () => {
    const verifying = Object.entries(jobs).filter(([, candidate]) =>
      commands(candidate).some((command) => command.includes(objectVerifier)));
    assert.ok(verifying.length >= 1);
    for (const [name, candidate] of verifying) {
      assert.ok(commands(candidate).some((command) => command.includes(revisionVerifier)), name);
    }
  });

  it('gates every physical-Mac E2E producer and consumer, including future jobs', () => {
    assert.deepEqual(physicalMacJobs(jobs).sort(), [
      'budget-e2e', 'build-ios-e2e-test-products', 'build-ios-native-test-products',
      'chat-plaid-e2e', 'income-e2e', 'onboarding-e2e', 'test-ios-execution',
      'verify-ios-release-archive',
    ]);
    const adversarial = {
      ...jobs,
      'direct-onboarding-check': jobSchema.parse({
        'runs-on': { labels: ['self-hosted', 'macOS', 'ios-xcode'] },
        needs: ['ios-change-gate'],
        if: "needs.ios-change-gate.outputs.onboarding_required == 'true'",
        steps: [{ run: 'bash scripts/ios-test-onboarding-e2e.sh' }],
      }),
    };
    assert.throws(() => physicalMacJobs(adversarial),
      /direct-onboarding-check must not run before the development schema gate/);
  });

  it('keeps PR migrations inert and runs privileged checks from the trusted verifier', () => {
    const schemaSteps = steps('prepare-dev-e2e-schema');
    const names = schemaSteps.map((candidate) => candidate.name ?? '');
    const install = names.indexOf('Install schema-verification dependencies');
    const manifest = names.indexOf('Materialize pull-request migrations as inert data');
    const auth = names.indexOf('Authenticate trusted schema verification to GCP');
    assert.ok(install >= 0 && manifest > install && auth > manifest);
    assert.match(schemaSteps[install]?.run ?? '', /npm ci.*--ignore-scripts/);
    assert.equal(schemaSteps[install]?.['working-directory'], 'trusted-verifier');
    assert.equal(schemaSteps[manifest]?.['working-directory'], 'trusted-verifier');
    assert.match(schemaSteps[manifest]?.run ?? '', /materializeDevE2eSchemaRevision\.ts/);
    assert.match(schemaSteps[manifest]?.run ?? '', /"\$GITHUB_WORKSPACE\/pr-source"/);
    assert.match(schemaSteps[manifest]?.run ?? '', /pr-source\/server\/db\/migrations/);

    const checkouts = schemaSteps.filter((candidate) => candidate.uses?.startsWith('actions/checkout@'));
    assert.equal(checkouts.length, 2);
    assert.deepEqual(checkouts[0]?.with, {
      path: 'pr-source', 'persist-credentials': false,
      ref: '${{ env.EXAMPLE_CI_EXACT_HEAD_SHA }}', 'sparse-checkout': 'server/db',
    });
    assert.equal(checkouts[1]?.with?.['path'], 'trusted-verifier');
    assert.equal(checkouts[1]?.with?.['persist-credentials'], false);

    for (const candidate of schemaSteps.slice(auth + 1)) {
      assert.doesNotMatch(candidate.run ?? '', /npm (?:run|exec|ci|install)|npx|pr-source/);
      if (candidate.run?.includes('node_modules/.bin/tsx')) {
        assert.equal(candidate['working-directory'], 'trusted-verifier');
      } else {
        assert.match(candidate.run ?? '', /^node trusted-verifier\/ci\/src\/actions\/ios\/\w+\.ts$/);
      }
    }

    const verifier = readFileSync(
      new URL('../../server/scripts/verifyDevE2eSchemaRevision.ts', import.meta.url), 'utf8',
    );
    assert.match(verifier, /BEGIN READ ONLY/);
    assert.match(verifier, /SHOW transaction_read_only/);
    assert.match(verifier, /ORDER BY created_at ASC, id ASC/);
    assert.match(verifier, /E2E_REQUIRED_MIGRATIONS_MANIFEST/);
    assert.doesNotMatch(verifier, /server\/db\/migrations/);
    for (const [name, candidate] of Object.entries(jobs)) {
      for (const command of commands(candidate)) {
        assert.doesNotMatch(command, /db:migrate/, `${name} must never apply PR migrations`);
      }
    }
  });
});


it('schema verification uses admitted hosted overflow and retains external fallback', () => {
  const schema = job('prepare-dev-e2e-schema');
  assert.ok(schema.needs?.includes('ios-change-gate'));
  const route = z.string().parse(schema['runs-on']);
  const expression = route.slice('${{'.length, -'}}'.length);
  const selected = (labels: string, sameRepository: boolean) => evaluateExpression(expression, {
    needs: { 'ios-change-gate': { outputs: { control_runner_labels: labels } } },
    github: { event_name: 'pull_request', repository: 'example-org/example-app',
      event: { pull_request: { head: { repo: { full_name: sameRepository ? 'example-org/example-app' : 'fork/site' } } } } },
  });
  const external = ['self-hosted', 'Linux', 'example-trusted-control'];
  assert.deepEqual(selected('["ubuntu-24.04"]', true), ['ubuntu-24.04']);
  assert.deepEqual(selected(JSON.stringify(external), true), external);
  assert.deepEqual(selected('', true), external);
  assert.deepEqual(selected('', false), ['ubuntu-24.04']);
  assert.deepEqual(schema.environment, { name: 'development-e2e' });
  assert.deepEqual(schema.permissions, { contents: 'read', 'id-token': 'write' });
});
