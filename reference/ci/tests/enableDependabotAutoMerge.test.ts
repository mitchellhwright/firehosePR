import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { load } from 'js-yaml';
import {
  AUTO_MERGE_DECISION_REASONS, autoMergeConfirmed, changesGithubActions, dependabotTrigger,
  enableCurrentDependabotAutoMerge,
} from '../src/actions/enableDependabotAutoMerge.ts';
import { workflowNames } from '../../scripts/ci/generated/workflow-names.ts';

const repository = 'example-org/example-app';
const sha = 'a'.repeat(40);
const branch = 'dependabot/npm/dependency';
const event = {
  workflow_run: {
    name: workflowNames['ios-tests'].workflow, event: 'pull_request', status: 'completed',
    conclusion: 'success', head_sha: sha, head_branch: branch,
    head_repository: { full_name: repository }, pull_requests: [],
  },
};
const pull = () => ({
  number: 42, node_id: 'PR_42', state: 'open', draft: false,
  user: { login: 'dependabot[bot]', type: 'Bot' }, auto_merge: null as null | { readonly merge_method: string },
  head: { sha, ref: branch, repo: { full_name: repository } },
  base: { ref: 'develop', sha: 'b'.repeat(40), repo: { full_name: repository } },
});
const commit = () => ({
  sha, author: { login: 'dependabot[bot]' }, committer: { login: 'web-flow' },
  parents: [{ sha: '0'.repeat(40) }], commit: {
    author: { email: '49699333+dependabot[bot]@users.noreply.github.com' },
    committer: { email: 'noreply@github.com' }, message: 'chore(deps): update dependency',
    verification: { verified: true, reason: 'valid' },
  },
});

function fixture() {
  let current = pull();
  const enabled: string[] = [];
  const rest = async (path: string): Promise<unknown> => {
    if (path.startsWith('pulls?')) return [current];
    if (path === 'pulls/42') return current;
    if (path.startsWith('pulls/42/files?')) return [{ filename: 'package-lock.json', status: 'modified' }];
    if (path.startsWith('pulls/42/commits?')) return [commit()];
    if (path.startsWith('issues/42/timeline?')) return [];
    throw new Error(`Unexpected path: ${path}`);
  };
  return {
    ports: { rest, enable: async (id: string) => { enabled.push(id); current = { ...current, auto_merge: { merge_method: 'squash' } }; } },
    enabled, set: (value: ReturnType<typeof pull>) => { current = value; }, get: () => current,
  };
}

test('completed iOS gate can identify an exact Dependabot head with an empty GitHub pull_requests list', () => {
  assert.deepEqual(dependabotTrigger(event, repository), { branch, sha });
  assert.equal(dependabotTrigger({ workflow_run: { ...event.workflow_run, conclusion: 'failure' } }, repository), null);
  assert.equal(dependabotTrigger({ workflow_run: { ...event.workflow_run, head_branch: 'feature' } }, repository), null);
});

test('verified current Dependabot head enables native auto-merge once', async () => {
  const f = fixture();
  assert.equal(await enableCurrentDependabotAutoMerge(event, repository, f.ports), 'enabled');
  assert.equal(await enableCurrentDependabotAutoMerge(event, repository, f.ports), 'already-enabled');
  assert.deepEqual(f.enabled, ['PR_42']);
});

test('stale run and non-dependency changes never enable auto-merge', async () => {
  const f = fixture();
  f.set({ ...f.get(), head: { ...f.get().head, sha: 'b'.repeat(40) } });
  assert.equal(await enableCurrentDependabotAutoMerge(event, repository, f.ports), 'stale');
  assert.deepEqual(f.enabled, []);

  const g = fixture();
  const rest = async (path: string): Promise<unknown> => path.startsWith('pulls/42/files?')
    ? [{ filename: 'server/index.ts', status: 'modified' }] : g.ports.rest(path);
  assert.equal(await enableCurrentDependabotAutoMerge(event, repository, { ...g.ports, rest }), 'untrusted');
  assert.deepEqual(g.enabled, []);
});

test('a trusted GitHub Actions pin update is left for manual merge queue entry', async () => {
  const f = fixture();
  const pin = (version: string, hex: string) => `      uses: actions/checkout@${hex.repeat(40)} # ${version}`;
  const workflowPin = {
    filename: '.github/workflows/pr-checks.yml', status: 'modified',
    patch: `@@ -10,1 +10,1 @@\n-${pin('v5.0.0', 'c')}\n+${pin('v5.0.1', 'd')}`,
  };
  const rest = async (path: string): Promise<unknown> => path.startsWith('pulls/42/files?')
    ? [{ filename: 'package-lock.json', status: 'modified' }, workflowPin] : f.ports.rest(path);
  assert.equal(await enableCurrentDependabotAutoMerge(event, repository, { ...f.ports, rest }), 'manual-enqueue-required');
  assert.deepEqual(f.enabled, []);
  assert.equal(AUTO_MERGE_DECISION_REASONS['manual-enqueue-required'], 'github-actions-change-requires-manual-enqueue');
});

test('only workflow and action paths count as GitHub Actions changes', () => {
  assert.equal(changesGithubActions([{ filename: '.github/workflows/ios-tests.yml' }]), true);
  assert.equal(changesGithubActions([{ filename: '.github/actions/setup/action.yml' }]), true);
  assert.equal(changesGithubActions([{ filename: '.github/dependabot.yml' }, { filename: 'package.json' }]), false);
  assert.equal(changesGithubActions([null, { filename: 7 }]), false);
});

test('head movement during evidence collection prevents auto-merge', async () => {
  const f = fixture();
  const rest = async (path: string): Promise<unknown> => {
    if (path.startsWith('pulls/42/files?')) f.set({ ...f.get(), head: { ...f.get().head, sha: 'b'.repeat(40) } });
    return f.ports.rest(path);
  };
  assert.equal(await enableCurrentDependabotAutoMerge(event, repository, { ...f.ports, rest }), 'stale');
  assert.deepEqual(f.enabled, []);
});

test('base movement during evidence collection prevents auto-merge', async () => {
  const f = fixture();
  const rest = async (path: string): Promise<unknown> => {
    if (path.startsWith('pulls/42/files?')) f.set({ ...f.get(), base: { ...f.get().base, sha: 'c'.repeat(40) } });
    return f.ports.rest(path);
  };
  assert.equal(await enableCurrentDependabotAutoMerge(event, repository, { ...f.ports, rest }), 'stale');
  assert.deepEqual(f.enabled, []);
});

test('the completed iOS workflow wires the typed action with a scoped App token', () => {
  const document = load(readFileSync(new URL('../../.github/workflows/refresh-pr-ci-after-base-edit.yml', import.meta.url), 'utf8')) as {
    readonly on: { readonly workflow_run: { readonly workflows: readonly string[]; readonly types: readonly string[] } };
    readonly jobs: { readonly 'resume-retained-ios': {
      readonly permissions: { readonly contents: string; readonly 'pull-requests': string };
      readonly steps: readonly { readonly id?: string; readonly run?: string; readonly env?: { readonly GITHUB_TOKEN?: string; readonly GITHUB_EVENT_TOKEN?: string }; readonly with?: { readonly 'permission-pull-requests'?: string; readonly 'permission-workflows'?: string } }[];
    } };
  };
  assert.deepEqual(document.on.workflow_run, { workflows: [workflowNames['ios-tests'].workflow], types: ['completed'] });
  const job = document.jobs['resume-retained-ios'];
  assert.equal(job.permissions.contents, 'read');
  assert.equal(job.permissions['pull-requests'], 'read');
  const token = job.steps.find(step => step.id === 'dependabot-merge-token');
  const action = job.steps.find(step => step.run === 'node ci/src/actions/enableDependabotAutoMerge.ts');
  const resume = job.steps.find(step => step.run === 'node ci/src/actions/resumeRetainedIosPredecessor.ts');
  assert.equal(token?.with?.['permission-pull-requests'], 'write');
  assert.equal(token?.with?.['permission-workflows'], undefined);
  assert.equal(action?.env?.GITHUB_TOKEN, '${{ steps.dependabot-merge-token.outputs.token }}');
  assert.match(resume?.env?.GITHUB_EVENT_TOKEN ?? '', /steps\.dependabot-merge-token\.outputs\.token/);
});

test('squash auto-merge or a merge queue entry confirms the request; anything else does not', () => {
  const answer = (pullRequest: unknown, errors?: unknown) => ({
    data: { enablePullRequestAutoMerge: { pullRequest } }, ...(errors === undefined ? {} : { errors }),
  });
  assert.equal(autoMergeConfirmed(answer({ autoMergeRequest: { mergeMethod: 'SQUASH' }, isInMergeQueue: false })), true);
  // A develop merge queue answers this way and merges with its own method.
  assert.equal(autoMergeConfirmed(answer({ autoMergeRequest: null, isInMergeQueue: true })), true);
  assert.equal(autoMergeConfirmed(answer({ autoMergeRequest: { mergeMethod: 'MERGE' }, isInMergeQueue: false })), false);
  assert.equal(autoMergeConfirmed(answer({ autoMergeRequest: null, isInMergeQueue: false })), false);
  assert.equal(autoMergeConfirmed(answer({ autoMergeRequest: null, isInMergeQueue: true }, [{ message: 'x' }])), false);
  assert.equal(autoMergeConfirmed({ data: null }), false);
});
