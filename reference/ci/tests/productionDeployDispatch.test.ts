import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { load } from 'js-yaml';
import { evaluateExpression, type ExpressionValue } from './fixtures/actionsExpression.ts';

/**
 * After every successful production deploy of main, the production onboarding
 * E2E runs for that exact commit: the Cloud Build example-production check run (or a
 * `production-deployed` dispatch) wakes production-deploy-dispatch.yml, which
 * dispatches the E2E on main. These tests evaluate the generated YAML, so a
 * source change that widens who can start a production run fails here.
 */

type Context = Record<string, ExpressionValue>;

interface Step {
  readonly id?: string;
  readonly name?: string;
  readonly env?: Readonly<Record<string, string>>;
  readonly run?: string;
}
interface Job {
  readonly if?: string;
  readonly permissions?: Readonly<Record<string, string>>;
  readonly environment?: { readonly name: string };
  readonly steps: readonly Step[];
}
interface Workflow {
  readonly on: Readonly<Record<string, unknown>>;
  readonly concurrency: { readonly group: string; readonly 'cancel-in-progress': boolean };
  readonly jobs: Readonly<Record<string, Job>>;
}

const DISPATCH_PATH = '.github/workflows/production-deploy-dispatch.yml';
const PRODUCTION_PATH = '.github/workflows/trusted-production-onboarding-e2e.yml';
const DISPATCH_PROGRAM = 'ci/src/actions/dispatchProductionE2e.ts';
const VALIDATE_SCRIPT =
  'scripts/ci/trusted-production-onboarding-e2e/validate-trusted-ref/validate-immutable-main-revision.sh';
const DEPLOYED = 'a'.repeat(40);
const OTHER = 'b'.repeat(40);
const RUN_ID = 424242;

const workflow = (path: string): Workflow => load(readFileSync(path, 'utf8')) as Workflow;
const dispatcher = workflow(DISPATCH_PATH);
const production = workflow(PRODUCTION_PATH);
const dispatchJob = dispatcher.jobs['dispatch-production-e2e'];
assert.ok(dispatchJob, 'the dispatcher job exists');

interface CheckRun {
  readonly appId: number;
  readonly appSlug: string;
  readonly name: string;
  readonly conclusion: string | null;
  readonly headBranch: string | null;
  readonly headSha: string;
}

const productionCheckRun: CheckRun = {
  appId: 10529,
  appSlug: 'google-cloud-build',
  name: 'example-production-site-trigger (example-production)',
  conclusion: 'success',
  headBranch: 'main',
  headSha: DEPLOYED,
};

function checkRunContext(checkRun: CheckRun): Context {
  return {
    github: {
      event_name: 'check_run',
      run_id: RUN_ID,
      ref: 'refs/heads/develop',
      event: {
        action: 'completed',
        check_run: {
          app: { id: checkRun.appId, slug: checkRun.appSlug },
          name: checkRun.name,
          conclusion: checkRun.conclusion,
          head_sha: checkRun.headSha,
          check_suite: { head_branch: checkRun.headBranch },
        },
      },
    },
  };
}

function dispatchContext(eventType: string, sha: string | null): Context {
  return {
    github: {
      event_name: 'repository_dispatch',
      run_id: RUN_ID,
      ref: 'refs/heads/develop',
      event: { action: eventType, client_payload: { sha } },
    },
  };
}

const admits = (context: Context): boolean =>
  Boolean(evaluateExpression(dispatchJob.if ?? 'true', context));

test('the dispatcher runs for the successful Cloud Build example-production check run', () => {
  assert.equal(admits(checkRunContext(productionCheckRun)), true);
});

test('the dispatcher ignores every other check run', () => {
  const rejected: ReadonlyArray<readonly [string, Partial<CheckRun>]> = [
    ['failure conclusion', { conclusion: 'failure' }],
    ['cancelled conclusion', { conclusion: 'cancelled' }],
    ['no conclusion', { conclusion: null }],
    ['staging trigger', { name: 'example-app-trigger (example-app)' }],
    ['GitHub Actions check run', { appId: 15368, appSlug: 'github-actions' }],
    ['Xcode Cloud check run', { appId: 117084, appSlug: 'xcode-cloud', name: 'example-ios | Example Release | Test - iOS' }],
    ['another app reusing the slug', { appId: 1 }],
    ['another app reusing the id', { appSlug: 'not-google-cloud-build' }],
    ['a non-main commit', { headBranch: 'develop' }],
    ['a detached commit', { headBranch: null }],
  ];
  for (const [label, change] of rejected) {
    assert.equal(admits(checkRunContext({ ...productionCheckRun, ...change })), false, label);
  }
});

test('the dispatcher keeps the production-deployed repository dispatch working', () => {
  assert.deepEqual(dispatcher.on, {
    check_run: { types: ['completed'] },
    repository_dispatch: { types: ['production-deployed'] },
  });
  assert.equal(admits(dispatchContext('production-deployed', DEPLOYED)), true);
  assert.equal(admits(dispatchContext('something-else', DEPLOYED)), false);
  assert.equal(admits({ github: { event_name: 'workflow_dispatch', run_id: RUN_ID } }), false);
});

test('the dispatcher hands the reported commit, and only it, to the typed program', () => {
  const step = dispatchJob.steps.find((candidate) => candidate.name === 'Dispatch exact main verification');
  assert.ok(step?.env);
  const deployedSha = step.env.DEPLOYED_SHA ?? '';
  assert.equal(evaluateExpression(deployedSha, checkRunContext(productionCheckRun)), DEPLOYED);
  assert.equal(evaluateExpression(deployedSha, dispatchContext('production-deployed', OTHER)), OTHER);
  assert.equal(evaluateExpression(deployedSha, dispatchContext('production-deployed', null)), '');
  assert.equal(step.env.GH_TOKEN, '${{ github.token }}');
  assert.equal(step.env.PRODUCTION_E2E_WORKFLOW, 'trusted-production-onboarding-e2e.yml');
  assert.equal(step.run, `node ${DISPATCH_PROGRAM}`);
  assert.deepEqual(dispatchJob.permissions, { actions: 'write', contents: 'read' });
});

test('reports of one commit share a concurrency key; unrelated check runs never do', () => {
  assert.equal(dispatcher.concurrency['cancel-in-progress'], false);
  const group = (context: Context): ExpressionValue => evaluateExpression(dispatcher.concurrency.group, context);
  const deployKey = `production-deploy-dispatch-sha-${DEPLOYED}`;
  assert.equal(group(checkRunContext(productionCheckRun)), deployKey);
  assert.equal(group(dispatchContext('production-deployed', DEPLOYED)), deployKey);
  assert.equal(
    group(checkRunContext({ ...productionCheckRun, conclusion: 'failure' })),
    `production-deploy-dispatch-run-${RUN_ID}`,
  );
  assert.equal(
    group(checkRunContext({ ...productionCheckRun, appId: 117084, appSlug: 'xcode-cloud' })),
    `production-deploy-dispatch-run-${RUN_ID}`,
  );
});

test('the production E2E runs only as a main dispatch, one run per revision', () => {
  assert.deepEqual(Object.keys(production.on), ['workflow_dispatch']);
  assert.deepEqual(production.on.workflow_dispatch, {
    inputs: {
      exact_sha: {
        description: 'Exact main commit SHA to test in production',
        required: true,
        type: 'string',
      },
    },
  });
  assert.equal(production.concurrency['cancel-in-progress'], false);
  const group = (sha: string): ExpressionValue =>
    evaluateExpression(production.concurrency.group, { inputs: { exact_sha: sha } });
  assert.equal(group(DEPLOYED), `trusted-production-onboarding-e2e-${DEPLOYED}`);
  assert.notEqual(group(DEPLOYED), group(OTHER));

  const validate = production.jobs['validate-trusted-ref']?.steps.find((step) => step.id === 'validate');
  assert.equal(validate?.env?.REQUESTED_SHA, '${{ inputs.exact_sha }}');
  assert.equal(validate.env.REF, '${{ github.ref }}');
  assert.deepEqual(production.jobs['production-onboarding-e2e']?.environment, { name: 'production-e2e' });
});

interface ScriptResult {
  readonly status: number | null;
  readonly stdout: string;
  readonly output: string;
  readonly ghCalls: readonly string[];
}

function runScript(script: string, env: Readonly<Record<string, string>>, gh = ''): ScriptResult {
  const workspace = mkdtempSync(join(tmpdir(), 'example-production-dispatch-'));
  try {
    const outputFile = join(workspace, 'output');
    const callLog = join(workspace, 'gh-calls');
    writeFileSync(outputFile, '');
    writeFileSync(callLog, '');
    const fakeGh = join(workspace, 'gh');
    writeFileSync(fakeGh, `#!/usr/bin/env bash\nset -euo pipefail\nprintf '%s\\n' "$*" >> "${callLog}"\n${gh}\n`);
    chmodSync(fakeGh, 0o755);
    const result = spawnSync(script.endsWith('.ts') ? process.execPath : 'bash', [script], {
      encoding: 'utf8',
      timeout: 10_000,
      env: {
        PATH: `${workspace}:${process.env.PATH ?? ''}`,
        GITHUB_OUTPUT: outputFile,
        GITHUB_REPOSITORY: 'example-org/example-app',
        ...env,
      },
    });
    return {
      status: result.status,
      stdout: `${result.stdout}${result.stderr}`,
      output: readFileSync(outputFile, 'utf8'),
      ghCalls: readFileSync(callLog, 'utf8').split('\n').filter((line) => line !== ''),
    };
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
}

/** A fake `gh` answering the two reads with `mainSha` and `activeRuns`. */
function fakeGh(mainSha: string, activeRuns: number | string): string {
  return [
    'case "$*" in',
    `  *git/ref/heads/main*) echo ${mainSha} ;;`,
    `  *actions/workflows/*/runs*) echo ${activeRuns} ;;`,
    '  "workflow run"*) ;;',
    '  *) echo "unexpected gh call: $*" >&2; exit 2 ;;',
    'esac',
  ].join('\n');
}

const dispatchEnv = { DEPLOYED_SHA: DEPLOYED, PRODUCTION_E2E_WORKFLOW: 'trusted-production-onboarding-e2e.yml' };

test('the typed dispatcher dispatches the E2E on main for the deployed head', () => {
  const result = runScript(DISPATCH_PROGRAM, dispatchEnv, fakeGh(DEPLOYED, 0));
  assert.equal(result.status, 0, result.stdout);
  assert.equal(result.ghCalls.length, 3);
  assert.match(result.ghCalls[1] ?? '', new RegExp(`event=workflow_dispatch&head_sha=${DEPLOYED}`));
  assert.equal(
    result.ghCalls[2],
    `workflow run trusted-production-onboarding-e2e.yml --repo example-org/example-app --ref main -f exact_sha=${DEPLOYED}`,
  );
});

test('the typed dispatcher does not dispatch a deploy main has moved past', () => {
  const result = runScript(DISPATCH_PROGRAM, dispatchEnv, fakeGh(OTHER, 0));
  assert.equal(result.status, 0, result.stdout);
  assert.match(result.stdout, /no longer the main head/);
  assert.equal(result.ghCalls.some((call) => call.startsWith('workflow run')), false);
});

test('the typed dispatcher does not dispatch a duplicate while a run is active', () => {
  const result = runScript(DISPATCH_PROGRAM, dispatchEnv, fakeGh(DEPLOYED, 1));
  assert.equal(result.status, 0, result.stdout);
  assert.match(result.stdout, /already queued or running/);
  assert.equal(result.ghCalls.some((call) => call.startsWith('workflow run')), false);
});

test('the typed dispatcher refuses a report without a commit SHA', () => {
  for (const sha of ['', 'main', DEPLOYED.toUpperCase(), `${DEPLOYED}0`]) {
    const result = runScript(DISPATCH_PROGRAM, { ...dispatchEnv, DEPLOYED_SHA: sha }, fakeGh(DEPLOYED, 0));
    assert.equal(result.status, 1, sha);
    assert.deepEqual(result.ghCalls, [], sha);
  }
});

test('the typed dispatcher fails closed when the active-run inventory is malformed', () => {
  const result = runScript(DISPATCH_PROGRAM, dispatchEnv, fakeGh(DEPLOYED, 'not-a-count'));
  assert.equal(result.status, 1, result.stdout);
  assert.match(result.stdout, /Could not read the active production E2E run count/);
  assert.equal(result.ghCalls.some((call) => call.startsWith('workflow run')), false);
});

test('the typed dispatcher fails closed when the main ref read fails', () => {
  const result = runScript(DISPATCH_PROGRAM, dispatchEnv, 'echo "API failed" >&2; exit 2');
  assert.equal(result.status, 1, result.stdout);
  assert.match(result.stdout, /API failed/);
  assert.equal(result.ghCalls.length, 1);
});

test('the revision check admits only a main dispatch of the main head', () => {
  const admitted = { EVENT_NAME: 'workflow_dispatch', REF: 'refs/heads/main', EVENT_SHA: DEPLOYED, REQUESTED_SHA: DEPLOYED };
  const result = runScript(VALIDATE_SCRIPT, admitted);
  assert.equal(result.status, 0, result.stdout);
  assert.equal(result.output, `exact_sha=${DEPLOYED}\n`);

  const refused: ReadonlyArray<readonly [string, Partial<typeof admitted>]> = [
    ['repository_dispatch', { EVENT_NAME: 'repository_dispatch' }],
    ['check_run', { EVENT_NAME: 'check_run' }],
    ['develop ref', { REF: 'refs/heads/develop' }],
    ['main moved on', { REQUESTED_SHA: OTHER }],
    ['empty request', { REQUESTED_SHA: '' }],
    ['not a SHA', { EVENT_SHA: 'main', REQUESTED_SHA: 'main' }],
  ];
  for (const [label, change] of refused) {
    const refusal = runScript(VALIDATE_SCRIPT, { ...admitted, ...change });
    assert.equal(refusal.status, 1, label);
    assert.equal(refusal.output, '', label);
  }
});
