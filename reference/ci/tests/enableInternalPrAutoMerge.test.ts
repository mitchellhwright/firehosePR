import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { load } from 'js-yaml';
import { enableInternalPrAutoMerge } from '../src/actions/enableInternalPrAutoMerge.ts';

const repository = 'example-org/example-app';
const sha = 'a'.repeat(40);
const pr = () => ({
  number: 7, node_id: 'PR_7', state: 'open', draft: false, auto_merge: null as null | object,
  user: { login: 'maintainer', type: 'User' },
  head: { sha, repo: { full_name: repository } },
  base: { ref: 'develop', sha: 'b'.repeat(40), repo: { full_name: repository } },
});
const event = () => ({ action: 'opened', pull_request: pr() });

function fixture() {
  let current = pr();
  let permission: unknown = { permission: 'write', user: { login: 'maintainer' } };
  const enabled: string[] = [];
  return {
    enabled,
    set: (next: ReturnType<typeof pr>) => { current = next; },
    setPermission: (next: unknown) => { permission = next; },
    get: () => current,
    ports: {
      rest: async (path: string): Promise<unknown> => {
        assert.equal(path, 'pulls/7');
        return current;
      },
      authorPermission: async (login: string): Promise<unknown> => {
        assert.equal(login, 'maintainer');
        return permission;
      },
      enable: async (nodeId: string): Promise<void> => {
        enabled.push(nodeId);
        current = { ...current, auto_merge: { merge_method: 'squash' } };
      },
    },
  };
}

test('internal current develop PR is armed once and GitHub remains merge authority', async () => {
  const f = fixture();
  assert.equal(await enableInternalPrAutoMerge(event(), repository, f.ports), 'enabled');
  assert.equal(await enableInternalPrAutoMerge(event(), repository, f.ports), 'already-enabled');
  assert.deepEqual(f.enabled, ['PR_7']);
});

test('read-only, triage, missing, and mismatched author permissions cannot arm auto-merge', async () => {
  for (const permission of [
    { permission: 'read', user: { login: 'maintainer' } },
    { permission: 'triage', user: { login: 'maintainer' } },
    null,
    { permission: 'write', user: { login: 'other-user' } },
  ]) {
    const f = fixture();
    f.setPermission(permission);
    assert.equal(await enableInternalPrAutoMerge(event(), repository, f.ports), 'ignored');
    assert.deepEqual(f.enabled, []);
  }
});

test('admin author can arm auto-merge, but permission lookup failures fail closed', async () => {
  const admin = fixture();
  admin.setPermission({ permission: 'admin', user: { login: 'maintainer' } });
  assert.equal(await enableInternalPrAutoMerge(event(), repository, admin.ports), 'enabled');
  const unavailable = fixture();
  await assert.rejects(enableInternalPrAutoMerge(event(), repository, {
    ...unavailable.ports,
    authorPermission: async () => { throw new Error('permission API unavailable'); },
  }), /permission API unavailable/);
  assert.deepEqual(unavailable.enabled, []);
});

test('drafts, forks, bots, main promotions, and ordinary edits are ignored', async () => {
  const f = fixture();
  const changes = [
    { ...event(), pull_request: { ...pr(), draft: true } },
    { ...event(), pull_request: { ...pr(), head: { ...pr().head, repo: { full_name: 'outsider/fork' } } } },
    { ...event(), pull_request: { ...pr(), user: { login: 'dependabot[bot]', type: 'Bot' } } },
    { ...event(), pull_request: { ...pr(), base: { ...pr().base, ref: 'main' } } },
    { ...event(), action: 'edited' },
  ];
  for (const change of changes) {
    assert.equal(await enableInternalPrAutoMerge(change, repository, f.ports), 'ignored');
  }
  assert.deepEqual(f.enabled, []);
});

test('stale head or base and draft transition cannot arm auto-merge', async () => {
  for (const changed of [
    { ...pr(), head: { ...pr().head, sha: 'c'.repeat(40) } },
    { ...pr(), base: { ...pr().base, ref: 'main' } },
    { ...pr(), draft: true },
    { ...pr(), user: { login: 'different', type: 'User' } },
  ]) {
    const f = fixture();
    f.set(changed);
    assert.equal(await enableInternalPrAutoMerge(event(), repository, f.ports), 'stale');
    assert.deepEqual(f.enabled, []);
  }
});

test('base or node changes between reads stop the mutation', async () => {
  const f = fixture();
  let reads = 0;
  const rest = async (path: string): Promise<unknown> => {
    reads++;
    if (reads === 2) f.set({ ...f.get(), base: { ...f.get().base, sha: 'c'.repeat(40) } });
    return f.ports.rest(path);
  };
  assert.equal(await enableInternalPrAutoMerge(event(), repository, { ...f.ports, rest }), 'stale');
  assert.deepEqual(f.enabled, []);
});

test('trusted default-branch workflow uses an App token and no PR-head code', () => {
  const workflow = load(readFileSync('.github/workflows/enable-internal-pr-auto-merge.yml', 'utf8')) as {
    readonly on: { readonly pull_request_target: { readonly types: readonly string[] } };
    readonly jobs: { readonly 'enable-auto-merge': {
      readonly steps: readonly {
        readonly uses?: string;
        readonly run?: string;
        readonly with?: {
          readonly ref?: string;
          readonly 'permission-contents'?: string;
          readonly 'permission-pull-requests'?: string;
        };
        readonly env?: { readonly GITHUB_TOKEN?: string };
      }[];
    } };
  };
  assert.deepEqual(workflow.on.pull_request_target.types,
    ['opened', 'reopened', 'ready_for_review', 'synchronize', 'edited']);
  const steps = workflow.jobs['enable-auto-merge'].steps;
  assert.equal(steps[0]?.with?.ref, '${{ github.event.repository.default_branch }}');
  assert.equal(steps[2]?.with?.['permission-contents'], 'write');
  assert.equal(steps[2]?.with?.['permission-pull-requests'], 'write');
  assert.match(steps[2]?.uses ?? '', /actions\/create-github-app-token@/);
  assert.equal(steps[3]?.run, 'node ci/src/actions/enableInternalPrAutoMerge.ts');
  assert.equal(steps[3]?.env?.GITHUB_TOKEN, '${{ steps.merge-token.outputs.token }}');
});
