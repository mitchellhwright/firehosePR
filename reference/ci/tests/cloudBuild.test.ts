import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { load } from 'js-yaml';
import {
  developBuild,
  developStepIds,
  developStepComments,
  type DevelopStepId,
} from '../cloudbuild/develop.ts';
import { cloudBuildInSync, renderCloudBuild, writeCloudBuild } from '../cloudbuild/lib/emit.ts';
import {
  productionBuild,
  productionCloudBuildTarget,
  productionStepComments,
  productionStepIds,
  type ProductionStepId,
} from '../cloudbuild/production.ts';
import { observabilityAlertsBuild, observabilityAlertsTarget } from '../cloudbuild/observabilityAlerts.ts';
import { plaidSyncBuild, plaidSyncStepIds, plaidSyncTarget } from '../cloudbuild/plaidSync.ts';
import { testflightFeedbackBuild, testflightFeedbackTarget } from '../cloudbuild/testflightFeedback.ts';
import {
  validateCloudBuild,
  type CloudBuild,
  type CloudBuildStep,
} from '../cloudbuild/lib/types.ts';
import { selectChecks } from '../src/checkRunner.ts';

// These fail compilation if dependencies become arbitrary strings or config fields widen.
const typedStep: CloudBuildStep<DevelopStepId> = {
  name: 'node',
  id: 'validate-generated-types',
  // @ts-expect-error Dependencies must be declared step IDs.
  waitFor: ['misspelled-step'],
};
void typedStep;
const typedConfig: CloudBuild<DevelopStepId> = {
  ...developBuild,
  // @ts-expect-error Unknown build options must not silently disappear.
  options: { ...developBuild.options, loging: 'NONE' },
};
void typedConfig;
const typedProductionStep: CloudBuildStep<ProductionStepId> = {
  name: 'node',
  id: 'test-coverage',
  // @ts-expect-error Production dependencies must be declared step IDs.
  waitFor: ['unlisted-production-step'],
};
void typedProductionStep;

test('emitter preserves the frozen migration fixture and current configuration when roundtripped', () => {
  const original = load(
    readFileSync('ci/tests/fixtures/pre-migration/cloudbuild.yaml', 'utf8')
  ) as CloudBuild<string>;
  assert.deepEqual(load(renderCloudBuild(original)), original);
  assert.deepEqual(load(renderCloudBuild(developBuild, developStepComments)), developBuild);
  assert.equal(developBuild.steps.length, developStepIds.length);
  assert.ok(cloudBuildInSync(process.cwd(), developBuild, developStepComments));
  const cleanup: CloudBuildStep<DevelopStepId> | undefined = developBuild.steps.find(
    step => step.id === 'configure-push-token-cleanup-trigger',
  );
  assert.equal(cleanup?.entrypoint, 'node');
  assert.deepEqual(cleanup?.args, ['ci/cloudbuild/runtime/reconcilePushTokenCleanupScheduler.ts']);
  assert.deepEqual(cleanup?.waitFor, ['verify-runtime-deployment']);
});

test('TestFlight feedback Cloud Build is generated from its typed definition', () => {
  assert.deepEqual(
    load(renderCloudBuild(testflightFeedbackBuild, undefined, testflightFeedbackTarget)),
    testflightFeedbackBuild,
  );
  assert.ok(cloudBuildInSync(process.cwd(), testflightFeedbackBuild, undefined,
    testflightFeedbackTarget));
});

test('observability alerts Cloud Build preserves its image-only behavior', () => {
  const original = load(readFileSync(
    'ci/tests/fixtures/pre-migration/cloudbuild-observability-alerts.yaml', 'utf8',
  )) as Record<string, unknown> & { steps: readonly Record<string, unknown>[] };
  const rendered = load(renderCloudBuild(
    observabilityAlertsBuild, undefined, observabilityAlertsTarget,
  ));
  assert.deepEqual(rendered, {
    ...original,
    steps: original.steps.map((step) => ({ ...step, id: 'build-image' })),
  });
  assert.ok(cloudBuildInSync(process.cwd(), observabilityAlertsBuild, undefined,
    observabilityAlertsTarget));
});

test('Plaid sync Cloud Build preserves deployment and uses typed scheduler reconciliation', () => {
  const original = load(readFileSync(
    'ci/tests/fixtures/pre-migration/cloudbuild-plaid-sync.yaml', 'utf8',
  )) as Record<string, unknown> & { steps: readonly Record<string, unknown>[] };
  const rendered = load(renderCloudBuild(plaidSyncBuild, undefined, plaidSyncTarget));
  assert.deepEqual(rendered, plaidSyncBuild);
  assert.deepEqual(plaidSyncBuild.steps.slice(0, 6), original.steps.slice(0, 6).map((step, index) => ({
      ...step,
      ...(index < 3 ? { id: plaidSyncStepIds[index] } : {}),
    })));
  assert.deepEqual(plaidSyncBuild.steps.at(-1), original.steps.at(-1));
  const grant = plaidSyncBuild.steps.find(step => step.id === 'grant-scheduler-invoker');
  assert.equal(grant?.entrypoint, 'gcloud');
  assert.deepEqual(grant?.waitFor, ['deploy-runtime']);
  const trigger = plaidSyncBuild.steps.find(step => step.id === 'configure-trigger');
  assert.equal(trigger?.name, 'node:26.5.0-alpine');
  assert.equal(trigger?.entrypoint, 'node');
  assert.deepEqual(trigger?.waitFor, ['deploy-runtime', 'grant-scheduler-invoker']);
  assert.deepEqual(trigger?.args, ['ci/cloudbuild/runtime/reconcilePlaidSyncScheduler.ts']);
  assert.equal(plaidSyncBuild.steps.length, plaidSyncStepIds.length);
  assert.ok(cloudBuildInSync(process.cwd(), plaidSyncBuild, undefined, plaidSyncTarget));
});

test('production Cloud Build preserves deployment while sharing typed cleanup reconciliation', () => {
  const original = load(readFileSync('ci/tests/fixtures/pre-migration/cloudbuild-prod.yaml', 'utf8')) as
    Record<string, unknown> & { steps: readonly Record<string, unknown>[] };
  const renderedSource = renderCloudBuild(productionBuild, productionStepComments, productionCloudBuildTarget);
  const rendered = load(renderedSource) as
    Record<string, unknown> & { steps: readonly Record<string, unknown>[] };
  const cleanupIndex = productionStepIds.indexOf('configure-push-token-cleanup-trigger');
  const notificationIndex = productionStepIds.indexOf('configure-notification-triggers');
  assert.deepEqual(rendered, {
    ...original,
    steps: original.steps.flatMap(step => {
      if (step.id === 'test-runtime-container') return rendered.steps.filter(candidate =>
        candidate.id === 'prepare-runtime-smoke-cli' || candidate.id === 'test-runtime-container');
      if (['configure-push-token-cleanup-trigger', 'configure-notification-triggers', 'pull-runtime-cache']
        .includes(String(step.id))) return rendered.steps.filter(candidate => candidate.id === step.id);
      return [step];
    }),
  });
  const cleanup: CloudBuildStep<ProductionStepId> | undefined = productionBuild.steps[cleanupIndex];
  assert.equal(cleanup?.entrypoint, 'node');
  assert.deepEqual(cleanup?.args, ['ci/cloudbuild/runtime/reconcilePushTokenCleanupScheduler.ts']);
  assert.deepEqual(cleanup?.waitFor, ['deploy-runtime']);
  const notification: CloudBuildStep<ProductionStepId> | undefined = productionBuild.steps[notificationIndex];
  assert.equal(notification?.entrypoint, 'node');
  assert.deepEqual(notification?.args, ['ci/cloudbuild/runtime/reconcileNotificationSchedulers.ts']);
  assert.deepEqual(notification?.waitFor, ['deploy-runtime']);
  assert.deepEqual(notification?.env, [
    'GCP_PROJECT_ID=$PROJECT_ID', 'GCP_REGION=us-east4',
    'SCHEDULER_AUDIENCE=${_NOTIFICATION_BASE_URL}',
    'SCHEDULER_SERVICE_ACCOUNT=${_NOTIFICATION_SCHEDULER_SERVICE_ACCOUNT}',
  ]);
  assert.match(renderedSource, /ADMIN_USER_EMAILS rollback version: 1/);
  assert.equal(productionBuild.steps.length, productionStepIds.length);
  assert.ok(cloudBuildInSync(process.cwd(), productionBuild, productionStepComments,
    productionCloudBuildTarget));
});

test('native cache failure tolerance cannot make validation or publication optional', () => {
  const builds: readonly (readonly [CloudBuild<string>, string])[] = [
    [developBuild, 'us-central1'], [productionBuild, 'us-east4'],
  ];
  for (const [build, region] of builds) {
    const cache = build.steps.find(step => step.id === 'pull-runtime-cache');
    assert.ok(cache);
    assert.equal(cache.entrypoint, undefined);
    assert.deepEqual(cache.args, ['pull', `${region}-docker.pkg.dev/$PROJECT_ID/example/example:latest`]);
    assert.equal(cache.allowFailure, true);
    for (const step of build.steps.filter(step => step.id !== 'pull-runtime-cache' && step.id !== 'index-rag-docs')) {
      assert.notEqual(step.allowFailure, true, `${step.id} must remain required`);
    }
    const image = build.steps.find(step => step.id === 'build-runtime');
    assert.ok(image);
    const dependencies: readonly string[] = image.waitFor ?? [];
    assert.ok(dependencies.includes('pull-runtime-cache'));
    assert.ok(image.args?.includes('--cache-from'));
  }
});

test('expensive develop work waits for the typed ownership preflight', () => {
  const step = (id: DevelopStepId): CloudBuildStep<DevelopStepId> => {
    const found = developBuild.steps.find(candidate => candidate.id === id);
    assert.ok(found);
    return found;
  };
  assert.equal(developStepIds[0], 'verify-initial-deployment-ownership');
  assert.deepEqual(step('verify-initial-deployment-ownership')?.args, [
    'ci/cloudbuild/runtime/runStagingPromotion.ts', 'ownership',
  ]);
  for (const id of ['install-dependencies', 'pull-runtime-cache'] as const) {
    assert.deepEqual(step(id)?.waitFor, ['verify-initial-deployment-ownership']);
  }
  assert.deepEqual(step('verify-runtime-deployment-ownership')?.args,
    step('verify-initial-deployment-ownership')?.args);
  assert.deepEqual(step('prepare-runtime-deployment')?.waitFor, ['verify-runtime-deployment-ownership']);
  assert.deepEqual(step('deploy-runtime')?.waitFor, ['prepare-runtime-deployment']);
});

test('the develop deploy build leaves lint to PR Checks and the merge queue', () => {
  for (const step of developBuild.steps) {
    assert.notDeepEqual(step.args, ['run', 'lint'], step.id);
  }
  const step = (id: DevelopStepId): CloudBuildStep<DevelopStepId> | undefined =>
    developBuild.steps.find(candidate => candidate.id === id);
  assert.deepEqual(step('validate-generated-types')?.waitFor, ['install-dependencies']);
  assert.deepEqual(step('push-runtime')?.waitFor, [
    'validate-generated-types', 'validate-chat-types', 'test-coverage', 'test-runtime-container',
  ]);
});

test('Cloud Build drift fails for missing output and handwritten changes', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'example-cloudbuild-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  assert.equal(cloudBuildInSync(root, developBuild, developStepComments), false);
  assert.equal(cloudBuildInSync(root, testflightFeedbackBuild, undefined,
    testflightFeedbackTarget), false);
  assert.equal(cloudBuildInSync(root, observabilityAlertsBuild, undefined,
    observabilityAlertsTarget), false);
  assert.equal(cloudBuildInSync(root, plaidSyncBuild, undefined,
    plaidSyncTarget), false);
  assert.equal(cloudBuildInSync(root, productionBuild, productionStepComments,
    productionCloudBuildTarget), false);
  writeCloudBuild(root, developBuild, developStepComments);
  writeCloudBuild(root, productionBuild, productionStepComments, productionCloudBuildTarget);
  writeCloudBuild(root, testflightFeedbackBuild, undefined, testflightFeedbackTarget);
  writeCloudBuild(root, observabilityAlertsBuild, undefined, observabilityAlertsTarget);
  writeCloudBuild(root, plaidSyncBuild, undefined, plaidSyncTarget);
  assert.equal(cloudBuildInSync(root, developBuild, developStepComments), true);
  assert.equal(cloudBuildInSync(root, testflightFeedbackBuild, undefined,
    testflightFeedbackTarget), true);
  assert.equal(cloudBuildInSync(root, observabilityAlertsBuild, undefined,
    observabilityAlertsTarget), true);
  assert.equal(cloudBuildInSync(root, plaidSyncBuild, undefined,
    plaidSyncTarget), true);
  assert.equal(cloudBuildInSync(root, productionBuild, productionStepComments,
    productionCloudBuildTarget), true);
  writeFileSync(
    join(root, 'cloudbuild.yaml'),
    renderCloudBuild(developBuild, developStepComments).replace(
      "timeout: '1800s'",
      "timeout: '1801s'"
    )
  );
  assert.equal(cloudBuildInSync(root, developBuild, developStepComments), false);
  writeCloudBuild(root, developBuild, developStepComments);
  assert.equal(cloudBuildInSync(root, developBuild, developStepComments), true);
  writeFileSync(join(root, testflightFeedbackTarget.path), 'steps: []\n');
  assert.equal(cloudBuildInSync(root, testflightFeedbackBuild, undefined,
    testflightFeedbackTarget), false);
  writeFileSync(join(root, productionCloudBuildTarget.path), 'steps: []\n');
  assert.equal(cloudBuildInSync(root, productionBuild, productionStepComments,
    productionCloudBuildTarget), false);
  writeFileSync(join(root, plaidSyncTarget.path), 'steps: []\n');
  assert.equal(cloudBuildInSync(root, plaidSyncBuild, undefined,
    plaidSyncTarget), false);
});

function withSteps(steps: readonly CloudBuildStep<string>[]): CloudBuild<string> {
  return { ...developBuild, steps };
}

test('invalid dependency graphs cannot be generated', () => {
  const step = { name: 'node', id: 'first' };
  for (const steps of [
    [],
    [step, step],
    [{ ...step, waitFor: ['missing'] }],
    [
      { ...step, waitFor: ['second'] },
      { name: 'node', id: 'second' },
    ],
    [{ ...step, waitFor: ['first'] }],
    [{ ...step, waitFor: ['-', 'first'] }],
  ])
    assert.throws(() => renderCloudBuild(withSteps(steps)));
  assert.doesNotThrow(() =>
    validateCloudBuild(
      withSteps([
        step,
        { name: 'node', id: 'parallel', waitFor: ['-'] },
        { name: 'node', id: 'last', waitFor: ['first', 'parallel'] },
      ])
    )
  );
});

test('secrets must be declared once before a build can be emitted', () => {
  assert.throws(
    () => renderCloudBuild(withSteps([{ name: 'node', id: 'first', secretEnv: ['NOT_DECLARED'] }])),
    /undeclared secret/
  );
  const secret = { versionName: 'projects/example/secrets/value/versions/latest', env: 'VALUE' };
  assert.throws(
    () =>
      renderCloudBuild({
        ...developBuild,
        availableSecrets: { secretManager: [secret, secret] },
      }),
    /Duplicate secret/
  );
});

test('required CI check includes Cloud Build drift and never rewrites generated output', () => {
  const checks = selectChecks(JSON.parse(readFileSync('package.json', 'utf8')));
  assert.ok(checks.includes('ci:cloudbuild:check'));
  assert.ok(!checks.includes('ci:cloudbuild'));
});
