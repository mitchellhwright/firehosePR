import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import { load } from 'js-yaml';

import { evaluateExpression, type ExpressionValue } from './fixtures/actionsExpression.ts';

import {
  controlHostedAdmission,
  currentHostedControlAdmission,
  externalBacklog,
  queuedJobsFor,
  runningJobsFor,
  selectControlRoute,
  type ControlRouteInput,
} from '../src/actions/selectControlRunners.ts';
import type { ApiRequest } from '../src/actions/selectPrLinuxRunners.ts';
import {
  hostedLinuxRunnerLabels,
  sharedPortableLinuxRunnerLabels,
  trustedControlLinuxRunnerLabels,
} from '../src/runnerPolicy.ts';

const EXTERNAL = trustedControlLinuxRunnerLabels;
const BACKLOG: ControlRouteInput = {
  sameRepository: true,
  external: EXTERNAL,
  queuedOnExternal: 3,
  hostedPolicyEnabled: true,
  hostedAdmitted: true,
};

describe('control job routing', () => {
  it('prefers the external fleet while nothing is queued for it', () => {
    assert.deepEqual(selectControlRoute({ ...BACKLOG, queuedOnExternal: 0 }),
      { labels: EXTERNAL, reason: 'external-free' });
  });

  it('overflows to hosted Linux only while the external fleet has a backlog', () => {
    assert.deepEqual(selectControlRoute(BACKLOG), { labels: hostedLinuxRunnerLabels, reason: 'external-backlog' });
  });

  it('keeps the external route when hosted overflow is disabled or unproven', () => {
    assert.deepEqual(selectControlRoute({ ...BACKLOG, hostedPolicyEnabled: false }),
      { labels: EXTERNAL, reason: 'hosted-policy-disabled' });
    assert.deepEqual(selectControlRoute({ ...BACKLOG, hostedAdmitted: false }),
      { labels: EXTERNAL, reason: 'hosted-admission-unproven' });
    assert.deepEqual(selectControlRoute({ ...BACKLOG, queuedOnExternal: undefined }),
      { labels: EXTERNAL, reason: 'external-inventory-unavailable' });
  });

  it('always isolates fork revisions on hosted Linux', () => {
    assert.deepEqual(selectControlRoute({ ...BACKLOG, sameRepository: false, queuedOnExternal: 0 }),
      { labels: hostedLinuxRunnerLabels, reason: 'fork-isolated' });
  });
});

describe('shared hosted admission for control jobs', () => {
  it('treats the current hosted control job as fresh admission, never a self-hosted job', () => {
    assert.deepEqual(currentHostedControlAdmission('github-hosted'),
      { available: true, reason: 'hosted-current-control-job' });
    assert.equal(currentHostedControlAdmission('self-hosted'), undefined);
    assert.equal(currentHostedControlAdmission(undefined), undefined);
  });
  const now = Date.parse('2026-09-29T02:00:00Z');
  const recentJob = {
    name: 'Server static validation', status: 'completed', conclusion: 'success',
    labels: hostedLinuxRunnerLabels, runner_name: 'GitHub Actions 123',
    started_at: '2026-09-29T01:55:00Z', completed_at: '2026-09-29T01:56:00Z',
    steps: [{ name: 'Check', status: 'completed', conclusion: 'success' }],
  };
  const requestFor = (probe: { conclusion: string; updated_at: string },
    recentJobs: readonly unknown[] = [recentJob]): ApiRequest => async (url) => {
    if (url.includes('/workflows/hosted-linux-admission.yml/runs')) {
      return { ok: true, status: 200, json: async () => ({ workflow_runs: [{
        id: 11, status: 'completed', ...probe,
      }] }) };
    }
    if (url.includes('/workflows/pr-checks.yml/runs')) {
      return { ok: true, status: 200, json: async () => ({ workflow_runs: [{
        id: 12, status: 'completed', conclusion: 'success',
      }] }) };
    }
    if (url.includes('/runs/11/jobs')) {
      return { ok: true, status: 200, json: async () => ({ jobs: [{
        ...recentJob, name: 'Hosted Linux admission probe',
        started_at: probe.updated_at, completed_at: probe.updated_at,
      }] }) };
    }
    if (url.includes('/runs/12/jobs')) {
      return { ok: true, status: 200, json: async () => ({ jobs: recentJobs }) };
    }
    throw new Error(`Unexpected URL: ${url}`);
  };
  const input = { apiUrl: 'https://api.test', repository: 'o/r',
    defaultBranch: 'develop', token: 't', now };

  it('admits on fresh successful hosted work when the latest probe is stale', async () => {
    const request = requestFor({ conclusion: 'success', updated_at: '2026-09-28T23:00:00Z' });
    assert.equal((await controlHostedAdmission({ ...input, request })).reason, 'hosted-recent-work-fresh');
  });

  it('uses a fresh probe without reading ten completed PR runs', async () => {
    const inner = requestFor({ conclusion: 'success', updated_at: '2026-09-29T01:58:00Z' });
    const urls: string[] = [];
    const request: ApiRequest = async (url, init) => {
      urls.push(url);
      return inner(url, init);
    };
    assert.equal((await controlHostedAdmission({ ...input, request })).reason, 'hosted-probe-fresh');
    assert.equal(urls.some(url => url.includes('/workflows/pr-checks.yml/runs')), false);
  });

  it('honors a newer failed probe over older successful work', async () => {
    const request = requestFor({ conclusion: 'failure', updated_at: '2026-09-29T01:59:00Z' });
    assert.deepEqual(await controlHostedAdmission({ ...input, request }),
      { available: false, reason: 'hosted-probe-failed' });
  });

  it('keeps control jobs external when neither proof is fresh', async () => {
    const request = requestFor({ conclusion: 'success', updated_at: '2026-09-28T23:00:00Z' }, []);
    const admission = await controlHostedAdmission({ ...input, request });
    assert.equal(admission.available, false);
    assert.equal(admission.reason, 'hosted-probe-stale');
  });
});

describe('external backlog', () => {
  const job = (runId: string, status: string, labels: readonly string[]) => ({
    name: 'job', status, labels, runId,
  });

  it('counts queued jobs of other runs that request the pool', () => {
    const jobs = [
      job('1', 'queued', trustedControlLinuxRunnerLabels),
      job('2', 'queued', [...trustedControlLinuxRunnerLabels, 'example-lane']),
      job('3', 'in_progress', trustedControlLinuxRunnerLabels),
      job('4', 'queued', sharedPortableLinuxRunnerLabels),
      job('5', 'queued', trustedControlLinuxRunnerLabels),
    ];
    assert.equal(queuedJobsFor(jobs, trustedControlLinuxRunnerLabels, '5'), 2);
    assert.equal(queuedJobsFor(jobs, sharedPortableLinuxRunnerLabels, '5'), 1);
    assert.equal(queuedJobsFor(jobs, hostedLinuxRunnerLabels, undefined), 0);
    assert.equal(runningJobsFor(jobs, trustedControlLinuxRunnerLabels, '5'), 1);
  });

  const CONTROL = { control: trustedControlLinuxRunnerLabels } as const;
  const BOTH = { control: trustedControlLinuxRunnerLabels, verdict: sharedPortableLinuxRunnerLabels } as const;
  const respond = (body: unknown) => ({ ok: true, status: 200, json: async () => body });
  // Runs 1..runCount are queued; each holds one queued job for `labelsFor(run)`.
  const fakeApi = (runCount: number, labelsFor: (run: number) => readonly string[], failing = new Set<number>()) => {
    const jobReads: number[] = [];
    const signals: (AbortSignal | null | undefined)[] = [];
    const request: ApiRequest = async (url, init) => {
      signals.push(init?.signal);
      if (url.includes('/runs?status=queued')) {
        const page = Number(/[?&]page=(\d+)/.exec(url)?.[1] ?? '1');
        const ids = Array.from({ length: runCount }, (_, index) => index + 1).slice((page - 1) * 100, page * 100);
        return respond({ workflow_runs: ids.map((id) => ({ id })) });
      }
      if (url.includes('/runs?status=in_progress')) return respond({ workflow_runs: [] });
      const run = Number(/runs\/(\d+)\/jobs/.exec(url)?.[1]);
      jobReads.push(run);
      if (failing.has(run)) return { ok: false, status: 502, json: async () => ({}) };
      return respond({ jobs: [{ name: `job-${run}`, status: 'queued', labels: labelsFor(run) }] });
    };
    return { request, jobReads, signals };
  };
  const scan = (request: ApiRequest, pools: Readonly<Record<string, readonly string[]>>, excludeRunId?: string) => (
    externalBacklog({ apiUrl: 'https://api.test', repository: 'o/r', token: 't', pools, excludeRunId, request }));

  it('stops reading job lists once every pool has a backlog', async () => {
    const api = fakeApi(50, () => trustedControlLinuxRunnerLabels);
    assert.deepEqual(await scan(api.request, CONTROL), { control: 10 });
    assert.equal(api.jobReads.length, 10);
  });

  it('treats two occupied trusted controller slots as saturation without a queued job', async () => {
    const request: ApiRequest = async (url) => {
      if (url.includes('/runs?status=queued')) return respond({ workflow_runs: [] });
      if (url.includes('/runs?status=in_progress')) return respond({ workflow_runs: [{ id: 1 }, { id: 2 }] });
      const run = Number(/runs\/(\d+)\/jobs/.exec(url)?.[1]);
      return respond({ jobs: [{ name: `control-${run}`, status: 'in_progress',
        labels: trustedControlLinuxRunnerLabels }] });
    };
    const base = { apiUrl: 'https://api.test', repository: 'o/r', token: 't',
      pools: CONTROL, poolSizes: { control: 2 }, request };
    assert.deepEqual(await externalBacklog({ ...base, excludeRunId: undefined }), { control: 1 });
    assert.deepEqual(await externalBacklog({ ...base, excludeRunId: '2' }), { control: 0 });
  });

  it('reads further batches until each pool has a backlog, skipping its own run', async () => {
    const api = fakeApi(25, (run) => (run === 23 ? sharedPortableLinuxRunnerLabels : trustedControlLinuxRunnerLabels));
    assert.deepEqual(await scan(api.request, BOTH, '1'), { control: 23, verdict: 1 });
    assert.equal(api.jobReads.includes(1), false);
    assert.equal(api.jobReads.length, 24);
  });

  it('scans at most MAX_RUNS_SCANNED runs', async () => {
    const api = fakeApi(500, () => hostedLinuxRunnerLabels);
    assert.deepEqual(await scan(api.request, CONTROL), { control: 0 });
    assert.equal(api.jobReads.length, 200);
  });

  it('keeps a backlog found despite unreadable runs, and reports unknown when it found none', async () => {
    const found = fakeApi(3, () => trustedControlLinuxRunnerLabels, new Set([1]));
    assert.deepEqual(await scan(found.request, CONTROL), { control: 2 });
    const none = fakeApi(3, () => hostedLinuxRunnerLabels, new Set([2]));
    assert.deepEqual(await scan(none.request, CONTROL), { control: undefined });
  });

  it('bounds every request with an abort signal', async () => {
    const api = fakeApi(2, () => trustedControlLinuxRunnerLabels);
    await scan(api.request, CONTROL);
    assert.ok(api.signals.length > 0 && api.signals.every((signal) => signal instanceof AbortSignal));
  });

  it('fails when the run list cannot be read, so the caller keeps the external route', async () => {
    const request: ApiRequest = async () => ({ ok: false, status: 502, json: async () => ({}) });
    await assert.rejects(scan(request, CONTROL), /HTTP 502/);
  });
});

describe('rendered control routes', () => {
  const REPOSITORY = 'example-org/example-app';
  const events: Record<string, Record<string, ExpressionValue>> = {
    'same-repository pull request': {
      event_name: 'pull_request',
      event: { pull_request: { head: { repo: { full_name: REPOSITORY } } } },
    },
    'fork pull request': {
      event_name: 'pull_request',
      event: { pull_request: { head: { repo: { full_name: 'outside/fork' } } } },
    },
    'queue candidate': { event_name: 'merge_group', event: {} },
    dispatch: { event_name: 'workflow_dispatch', event: {} },
  };
  const rerouted = {
    'pr-checks': { planner: 'plan-pr-validation', jobs: { 'validation-policy': 'control', validate: 'control' } },
    'ios-tests': {
      planner: 'ios-change-gate',
      jobs: {
        'release-full-routing-predecessor': 'control', 'await-retained-ios-predecessor': 'control',
        'confirm-current-ios-pr': 'control', 'test-ios': 'control', 'onboarding-e2e-status': 'control',
        'remove-run-artifacts-after-success': 'control', 'storekit-purchase-status': 'control',
      },
    },
  } as const;
  const external = { control: trustedControlLinuxRunnerLabels };

  it('keeps the first PR route on external control when hosted overflow policy is off', () => {
    const document = load(readFileSync('.github/workflows/pr-checks.yml', 'utf8')) as {
      jobs: Record<string, { 'runs-on': string }>;
    };
    const expression = document.jobs['route-initial-control']?.['runs-on'] ?? '';
    for (const [label, event] of Object.entries(events)) {
      const context = { github: { repository: REPOSITORY, ...event },
        vars: { CI_HOSTED_LINUX_AVAILABLE: '0' } };
      const expected = label === 'fork pull request'
        ? hostedLinuxRunnerLabels : trustedControlLinuxRunnerLabels;
      assert.deepEqual(evaluateExpression(expression, context), [...expected], label);
      assert.deepEqual(evaluateExpression(expression, {
        ...context, vars: { CI_HOSTED_LINUX_AVAILABLE: '1' },
      }), [...hostedLinuxRunnerLabels], `${label} policy enabled`);
    }
  });

  for (const [file, { planner, jobs }] of Object.entries(rerouted)) {
    const workflow = load(readFileSync(`.github/workflows/${file}.yml`, 'utf8')) as {
      jobs: Record<string, { 'runs-on': string }>;
    };
    const route = (job: string, event: Record<string, ExpressionValue>, planned: string) => evaluateExpression(
      workflow.jobs[job]?.['runs-on'] ?? '',
      {
        github: { repository: REPOSITORY, ...event },
        inputs: {},
        needs: { [planner]: { outputs: { control_runner_labels: planned } } },
      },
    );

    it(`${file}: an empty planned route renders the static route for every event`, () => {
      for (const [job, pool] of Object.entries(jobs)) {
        for (const [label, event] of Object.entries(events)) {
          const expected = label === 'fork pull request' ? hostedLinuxRunnerLabels : external[pool];
          assert.deepEqual(route(job, event, ''), [...expected], `${job} ${label}`);
        }
      }
    });

    it(`${file}: a planned route replaces the static one`, () => {
      for (const job of Object.keys(jobs)) {
        assert.deepEqual(route(job, events['queue candidate'] ?? {}, JSON.stringify(hostedLinuxRunnerLabels)),
          [...hostedLinuxRunnerLabels], job);
      }
    });
  }
});
