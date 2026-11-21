import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import { load } from 'js-yaml';

import {
  applyRecheck, decidePullRequestRecheck, formatDecision, parseRecheckTrigger, planPromotionRecheck,
  type PullRequestRun, type RecheckDecision, type RecheckTrigger,
} from '../src/ios/promotionRecheck.ts';
import type { GithubResponse } from '../src/ios/shared/githubRest.ts';
import { evaluateExpression, type ExpressionValue } from './fixtures/actionsExpression.ts';

const repository = 'example-org/example-app';
const api = 'https://api.github.test';
const source = 'a'.repeat(40);
const mainSha = 'b'.repeat(40);
const prHead = 'c'.repeat(40);
const branch = `promotion/develop-${source}`;
const repo = { full_name: repository };
const evidenceDoneAt = '2026-09-25T02:00:00Z';

const evidencePayloadRun = {
  id: 900, name: `promotion-evidence:${source}:${mainSha}`, event: 'workflow_dispatch', status: 'completed', conclusion: 'success',
  head_branch: 'develop', head_sha: source, path: '.github/workflows/ios-tests.yml',
  display_title: `promotion-evidence:${source}:${mainSha}`, repository: repo, head_repository: repo,
};
const prPayloadRun = {
  ...evidencePayloadRun, id: 800, name: 'Test - iOS', event: 'pull_request', conclusion: 'failure',
  head_branch: branch, head_sha: prHead, display_title: 'Test - iOS',
};

function pullRun(overrides: Partial<PullRequestRun> = {}): PullRequestRun {
  return {
    id: 123, event: 'pull_request', status: 'completed', conclusion: 'failure', head_sha: prHead,
    path: '.github/workflows/ios-tests.yml', created_at: '2026-09-25T00:10:00Z',
    run_started_at: '2026-09-25T00:10:00Z', repository: repo, ...overrides,
  };
}

const decide = (runs: readonly PullRequestRun[]): RecheckDecision => decidePullRequestRecheck({
  pullRequest: 6158, headSha: prHead, repository, runs, evidenceCompletedAt: evidenceDoneAt,
});

test('a run whose gate failed before the evidence completed is rerun', () => {
  const decision = decide([pullRun()]);
  assert.deepEqual(decision, { action: 'rerun', pullRequest: 6158, runId: 123, reason: 'gate ran before the evidence completed' });
  assert.equal(formatDecision(decision), 'promotion-recheck: rerun #6158 run 123 (gate ran before the evidence completed)');
  assert.equal(decide([pullRun({ conclusion: 'cancelled' })]).action, 'rerun');
});

test('active, passing, missing and post-evidence runs are left alone', () => {
  assert.match(decide([pullRun({ status: 'in_progress', conclusion: null })]).reason, /still active/);
  assert.match(decide([pullRun({ status: 'queued', conclusion: null })]).reason, /still active/);
  assert.equal(decide([pullRun({ conclusion: 'success' })]).action, 'none');
  assert.equal(decide([pullRun({ conclusion: 'action_required' })]).action, 'none');
  assert.match(decide([]).reason, /no Test - iOS run/);
  const afterEvidence = decide([pullRun({ run_started_at: '2026-09-25T02:00:00Z' })]);
  assert.equal(afterEvidence.action, 'none');
  assert.match(afterEvidence.reason, /started after the evidence/);
});

test('only the newest pull_request run at the current head decides', () => {
  const older = pullRun({ id: 1, created_at: '2026-09-25T00:00:00Z' });
  const newer = pullRun({ id: 2, created_at: '2026-09-25T01:00:00Z', status: 'in_progress', conclusion: null });
  assert.equal(decide([older, newer]).runId, 2);
  assert.equal(decide([pullRun({ head_sha: 'd'.repeat(40) })]).action, 'none');
  assert.equal(decide([pullRun({ event: 'workflow_dispatch' })]).action, 'none');
  assert.equal(decide([pullRun({ repository: { full_name: 'fork/example-app' } })]).action, 'none');
});

test('the trigger accepts only a successful exact-develop evidence dispatch', () => {
  assert.deepEqual(parseRecheckTrigger({ workflow_run: evidencePayloadRun }, repository), {
    accepted: true, trigger: { kind: 'evidence', runId: 900, sourceSha: source, evidenceBaseSha: mainSha },
  });
  const declined = (overrides: Record<string, unknown>): boolean =>
    !parseRecheckTrigger({ workflow_run: { ...evidencePayloadRun, ...overrides } }, repository).accepted;
  assert.ok(declined({ conclusion: 'failure' }));
  assert.ok(declined({ head_branch: 'feature' }));
  assert.ok(declined({ head_sha: 'e'.repeat(40) }));
  assert.ok(declined({ display_title: `promotion-evidence:${source}:${mainSha}x` }));
  assert.ok(declined({ display_title: `promotion-evidence:${source.toUpperCase()}:${mainSha}` }));
  assert.ok(declined({ display_title: 'Test - iOS' }));
  assert.ok(declined({ event: 'push' }));
  assert.ok(declined({ path: '.github/workflows/pr-checks.yml' }));
  assert.ok(declined({ repository: { full_name: 'fork/example-app' } }));
  assert.ok(declined({ head_repository: { full_name: 'fork/example-app' } }));
  assert.ok(declined({ status: 'in_progress' }));
  assert.throws(() => parseRecheckTrigger({ workflow_run: { id: 'x' } }, repository));
});

test('the trigger accepts a failed promotion PR run and nothing else from pull requests', () => {
  assert.deepEqual(parseRecheckTrigger({ workflow_run: prPayloadRun }, repository), {
    accepted: true, trigger: { kind: 'pull-request-run', runId: 800, sourceSha: source },
  });
  const declined = (overrides: Record<string, unknown>): boolean =>
    !parseRecheckTrigger({ workflow_run: { ...prPayloadRun, ...overrides } }, repository).accepted;
  assert.ok(declined({ conclusion: 'success' }));
  assert.ok(declined({ head_branch: 'feature' }));
  assert.ok(declined({ head_branch: `${branch}-x` }));
  assert.ok(declined({ head_repository: null }));
});

type Route = (url: string) => GithubResponse | undefined;
const ok = (body: unknown): GithubResponse => ({ status: 200, statusLabel: '200', body });

function evidenceRun(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 900, run_attempt: 1, created_at: '2026-09-25T00:00:00Z', updated_at: evidenceDoneAt,
    event: 'workflow_dispatch', head_branch: 'develop', head_sha: source, path: '.github/workflows/ios-tests.yml',
    display_title: `promotion-evidence:${source}:${mainSha}`, status: 'completed', conclusion: 'success',
    repository: repo, ...overrides,
  };
}

function pull(number: number, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    number, state: 'open', head: { ref: branch, sha: prHead, repo },
    base: { ref: 'main', sha: mainSha, repo }, ...overrides,
  };
}

interface World {
  readonly main?: string;
  readonly evidence?: readonly Record<string, unknown>[];
  readonly pulls?: readonly Record<string, unknown>[];
  readonly runs?: readonly PullRequestRun[];
}

function reader(world: World): { readonly read: (url: string) => Promise<GithubResponse>; readonly urls: string[] } {
  const urls: string[] = [];
  const routes: readonly Route[] = [
    (url) => url.endsWith('/git/ref/heads/main') ? ok({ object: { sha: world.main ?? mainSha } }) : undefined,
    (url) => url.includes('event=workflow_dispatch')
      ? ok({ total_count: (world.evidence ?? [evidenceRun()]).length, workflow_runs: world.evidence ?? [evidenceRun()] })
      : undefined,
    (url) => url.includes('/pulls?') ? ok(world.pulls ?? [pull(6158)]) : undefined,
    (url) => url.includes('event=pull_request')
      ? ok({ total_count: (world.runs ?? [pullRun()]).length, workflow_runs: world.runs ?? [pullRun()] })
      : undefined,
  ];
  return {
    urls,
    read: async (url: string) => {
      urls.push(url);
      for (const route of routes) {
        const response = route(url);
        if (response !== undefined) return response;
      }
      throw new Error(`unexpected read ${url}`);
    },
  };
}

const evidenceTrigger: RecheckTrigger = { kind: 'evidence', runId: 900, sourceSha: source, evidenceBaseSha: mainSha };
const plan = async (world: World, trigger: RecheckTrigger = evidenceTrigger): Promise<readonly RecheckDecision[]> =>
  planPromotionRecheck({ api, repository, read: reader(world).read }, trigger);

test('evidence completion reruns the failed gate of the matching checkpoint PR', async () => {
  const { read, urls } = reader({});
  const decisions = await planPromotionRecheck({ api, repository, read }, evidenceTrigger);
  assert.deepEqual(decisions.map((decision) => [decision.action, decision.pullRequest, decision.runId]),
    [['rerun', 6158, 123]]);
  assert.ok(urls.includes(`${api}/repos/${repository}/pulls?state=open&base=main&head=example-org:${branch}&per_page=100`));
  assert.ok(urls.includes(`${api}/repos/${repository}/actions/workflows/ios-tests.yml/runs?event=pull_request&head_sha=${prHead}&per_page=100`));
});

test('a moved main does nothing, before reading any pull request', async () => {
  const { read, urls } = reader({ main: 'f'.repeat(40) });
  const decisions = await planPromotionRecheck({ api, repository, read }, evidenceTrigger);
  assert.equal(decisions.length, 1);
  assert.equal(decisions[0]?.action, 'none');
  assert.match(decisions[0]?.reason ?? '', /main moved/);
  assert.equal(urls.some((url) => url.includes('/pulls?')), false);
});

test('a PR-run trigger waits for passing evidence against the current main', async () => {
  const prTrigger: RecheckTrigger = { kind: 'pull-request-run', runId: 800, sourceSha: source };
  assert.equal((await plan({}, prTrigger))[0]?.action, 'rerun');
  const inProgress = await plan({ evidence: [evidenceRun({ status: 'in_progress', conclusion: null })] }, prTrigger);
  assert.match(inProgress[0]?.reason ?? '', /missing or has not passed/);
  // A newer failing evidence attempt invalidates the older pass.
  const newerFailure = await plan({ evidence: [
    evidenceRun(), evidenceRun({ id: 901, created_at: '2026-09-25T03:00:00Z', conclusion: 'failure' }),
  ] }, prTrigger);
  assert.equal(newerFailure[0]?.action, 'none');
  const otherBase = await plan({ evidence: [evidenceRun({ display_title: `promotion-evidence:${source}:${'e'.repeat(40)}` })] }, prTrigger);
  assert.equal(otherBase[0]?.action, 'none');
});

test('no, foreign, and several checkpoint pull requests', async () => {
  const none = await plan({ pulls: [] });
  assert.deepEqual(none.map(formatDecision), [`promotion-recheck: none (no open ${branch} pull request into main)`]);
  const foreign = await plan({ pulls: [
    pull(1, { head: { ref: branch, sha: prHead, repo: { full_name: 'fork/example-app' } } }),
    pull(2, { base: { ref: 'develop', sha: mainSha, repo } }),
    pull(3, { head: { ref: `${branch}-x`, sha: prHead, repo } }),
    pull(4, { state: 'closed' }),
  ] });
  assert.equal(foreign[0]?.action, 'none');
  assert.equal(foreign[0]?.pullRequest, undefined);
  const several = await plan({ pulls: [pull(10), pull(11, { base: { ref: 'main', sha: 'e'.repeat(40), repo } })] });
  assert.deepEqual(several.map((decision) => [decision.action, decision.pullRequest]), [['rerun', 10], ['none', 11]]);
  assert.match(several[1]?.reason ?? '', /not main/);
});

test('an incomplete run inventory fails closed instead of guessing the newest run', async () => {
  const read = async (url: string): Promise<GithubResponse> => url.includes('event=pull_request')
    ? ok({ total_count: 101, workflow_runs: [pullRun()] })
    : reader({}).read(url);
  await assert.rejects(planPromotionRecheck({ api, repository, read }, evidenceTrigger), /exceed one page/);
  const denied = async (url: string): Promise<GithubResponse> => url.endsWith('/heads/main')
    ? { status: 404, statusLabel: '404', body: undefined }
    : reader({}).read(url);
  await assert.rejects(planPromotionRecheck({ api, repository, read: denied }, evidenceTrigger), /HTTP 404/);
});

test('apply posts rerun-failed-jobs only for rerun decisions and fails on a refused rerun', async () => {
  const posted: string[] = [];
  const request = async (method: string, url: string): Promise<GithubResponse> => {
    posted.push(`${method} ${url}`);
    return { status: 201, statusLabel: '201', body: undefined };
  };
  await applyRecheck({ api, repository, request }, [
    { action: 'rerun', pullRequest: 1, runId: 11, reason: 'r' },
    { action: 'none', pullRequest: 2, runId: 22, reason: 'n' },
  ]);
  assert.deepEqual(posted, [`POST ${api}/repos/${repository}/actions/runs/11/rerun-failed-jobs`]);
  const refused = async (): Promise<GithubResponse> => ({ status: 403, statusLabel: '403', body: undefined });
  await assert.rejects(applyRecheck({ api, repository, request: refused },
    [{ action: 'rerun', pullRequest: 1, runId: 11, reason: 'r' }]), /HTTP 403/);
});

interface RecheckJob {
  readonly if: string;
  readonly permissions: Readonly<Record<string, string>>;
  readonly concurrency: { readonly group: string; readonly 'cancel-in-progress': boolean };
  readonly steps: readonly { readonly with?: Readonly<Record<string, string>> }[];
}
const workflow = load(readFileSync(new URL('../../.github/workflows/refresh-pr-ci-after-base-edit.yml', import.meta.url), 'utf8')) as {
  readonly jobs: Readonly<Record<string, RecheckJob>>;
};
const recheckJob = workflow.jobs['recheck-promotion-after-evidence'];
if (recheckJob === undefined) throw new Error('recheck-promotion-after-evidence job is missing');

function fires(run: Readonly<Record<string, ExpressionValue>>, eventName = 'workflow_run'): boolean {
  const context = { github: { event_name: eventName, event: { workflow_run: run } } };
  return Boolean(evaluateExpression(recheckJob?.if ?? '', context));
}

test('the job fires only for successful promotion evidence and failed promotion PR runs', () => {
  assert.ok(fires(evidencePayloadRun));
  assert.ok(fires(prPayloadRun));
  assert.ok(fires({ ...prPayloadRun, conclusion: 'cancelled' }));
  assert.equal(fires(evidencePayloadRun, 'push'), false);
  assert.equal(fires({ ...evidencePayloadRun, conclusion: 'failure' }), false);
  assert.equal(fires({ ...evidencePayloadRun, head_branch: 'feature' }), false);
  assert.equal(fires({ ...evidencePayloadRun, display_title: 'Test - iOS' }), false);
  assert.equal(fires({ ...evidencePayloadRun, event: 'push' }), false);
  assert.equal(fires({ ...evidencePayloadRun, path: '.github/workflows/pr-checks.yml' }), false);
  assert.equal(fires({ ...prPayloadRun, conclusion: 'success' }), false);
  assert.equal(fires({ ...prPayloadRun, head_branch: 'codex/feature' }), false);
});

test('the job holds only the grants it needs and serialises per checkpoint source', () => {
  assert.deepEqual(recheckJob.permissions, { actions: 'write', contents: 'read', 'pull-requests': 'read' });
  assert.equal(recheckJob.concurrency['cancel-in-progress'], false);
  const group = (run: Readonly<Record<string, ExpressionValue>>): ExpressionValue =>
    evaluateExpression(recheckJob.concurrency.group, { github: { event: { workflow_run: run } } });
  assert.equal(group(evidencePayloadRun), `promotion-recheck-${branch}`);
  assert.equal(group(prPayloadRun), group(evidencePayloadRun));
  assert.ok(recheckJob.steps.some((step) => step.with?.['entry'] === 'ci/src/actions/ios/recheckPromotionAfterEvidence.ts'));
});
