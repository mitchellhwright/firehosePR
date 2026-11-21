import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { it } from 'node:test';
import { dump, load } from 'js-yaml';
import { findEquivalentPatchHead, main as deltaMain, iosProductVerifiedLineageFiles, loadEquivalentIosE2eProductInputs } from '../src/ios/controllers/baseUpdateDelta.ts';
import { isPatchEquivalentTargetUpdate, type GithubObject as CancellationObject } from '../src/actions/cancelObsoleteIosRuns.ts';
import { hopByHopLineageEquivalence, type GithubObject as ResumeObject } from '../src/actions/resumeRetainedIosPredecessor.ts';
import { isReusableIosWorkflowLineage } from '../src/ios/workflowEvidenceInputs.ts';
import type { GitHubJson, GitHubJsonReader } from '../../scripts/ci/types/github.d.mts';

const source = readFileSync('.github/workflows/ios-tests.yml', 'utf8');
const priorHead = '1'.repeat(40);
const currentHead = '2'.repeat(40);
function snapshot(source: string) {
  const sha = createHash('sha1').update(`blob ${Buffer.byteLength(source)}\0`).update(source).digest('hex');
  return { sha, blob: { encoding: 'base64', content: Buffer.from(source).toString('base64'), size: Buffer.byteLength(source) },
    tree: { truncated: false, tree: [
      { path: '.github/workflows/ios-tests.yml', type: 'blob', mode: '100644', sha },
      { path: 'ios/example-ios/App.swift', type: 'blob', mode: '100644', sha: '3'.repeat(40) },
      { path: 'scripts/build-ios-e2e-test-products.sh', type: 'blob', mode: '100644', sha: '4'.repeat(40) },
    ] } };
}
const original = snapshot(source);
function changed(job: string) {
  const workflow = load(source) as { jobs: Record<string, Record<string, unknown>> };
  workflow.jobs[job]!.env = { MODIFIED_INPUT: 'true' };
  return snapshot(dump(workflow, { lineWidth: -1 }));
}
it('reads hash-verified predecessor/current workflow blobs before proving product equivalence', async () => {
  for (const job of ['budget-e2e-video-processing', 'build-ios-e2e-test-products', 'ios-change-gate']) {
    const next = changed(job);
    const requested: string[] = [];
    const request: GitHubJsonReader = async (path) => {
      requested.push(path);
      if (path === `git/trees/${priorHead}?recursive=1`) return original.tree;
      if (path === `git/trees/${currentHead}?recursive=1`) return next.tree;
      if (path === `git/blobs/${original.sha}`) return original.blob;
      if (path === `git/blobs/${next.sha}`) return next.blob;
      throw new Error(`Unexpected endpoint ${path}`);
    };
    const result = await loadEquivalentIosE2eProductInputs({ priorHead, currentHead, request, token: undefined });
    if (job === 'budget-e2e-video-processing') {
      assert.ok(result);
      assert.equal(result.priorHead, priorHead);
      assert.equal(result.currentHead, currentHead);
      assert.equal(result.workflowEvidenceEquivalent, true);
      const lineage = [{ filename: '.github/workflows/ios-tests.yml', status: 'modified' },
        { filename: 'ios/example-ios/App.swift', status: 'modified' }];
      assert.deepEqual(iosProductVerifiedLineageFiles(lineage, result, priorHead, currentHead), [lineage[1]]);
      assert.deepEqual(iosProductVerifiedLineageFiles(lineage, result, '0'.repeat(40), currentHead), lineage);
      assert.deepEqual(iosProductVerifiedLineageFiles(lineage, { ...result, workflowEvidenceEquivalent: false }, priorHead, currentHead), lineage);
    } else assert.equal(result, null, job);
    assert.equal(requested.filter((path) => path.startsWith('git/blobs/')).length, 2);
  }
});
it('deduplicates an identical workflow blob and refuses corrupt or missing object evidence', async () => {
  for (const blob of [original.blob, {}, { ...original.blob, content: Buffer.from('tampered').toString('base64') }]) {
    let blobs = 0;
    const request: GitHubJsonReader = async (path) => {
      if (path.startsWith('git/trees/')) return original.tree;
      blobs += 1;
      return blob;
    };
    const result = await loadEquivalentIosE2eProductInputs({ priorHead, currentHead, request, token: undefined });
    assert.equal(blobs, 1);
    assert.equal(result !== null, blob === original.blob);
  }
});

it('keeps deleted and renamed workflows invalidating even with an equivalent producer proof', () => {
  const proof = { priorHead, currentHead, digest: 'a'.repeat(64), workflowEvidenceEquivalent: true };
  for (const file of [
    { filename: '.github/workflows/ios-tests.yml', status: 'removed' },
    { filename: '.github/workflows/ios-tests.yml', status: 'renamed', previous_filename: 'old.yml' },
    { filename: 'old.yml', status: 'renamed', previous_filename: '.github/workflows/ios-tests.yml' },
  ]) assert.deepEqual(iosProductVerifiedLineageFiles([file], proof, priorHead, currentHead), [file]);
});

it('the completed-run controller retains evidence for an unrelated workflow edit and rejects affected lanes', async () => {
  const oldBase = '5'.repeat(40);
  const base = '6'.repeat(40);
  const repository = { full_name: 'example-org/example-app' };
  const pr = { number: 42, head: { sha: currentHead, repo: repository }, base: { ref: 'develop', sha: base, repo: repository } };
  const commit = { sha: currentHead, parents: [{ sha: priorHead }, { sha: base }],
    commit: { message: 'chore: update PR #42 from develop' } };
  const patch = [{ filename: 'ios/example-ios/App.swift', status: 'modified', sha: '7'.repeat(40),
    additions: 1, deletions: 1, changes: 2, patch: '@@ -1 +1 @@\n-old\n+new' }];
  const lineage = { status: 'ahead', merge_base_commit: { sha: oldBase },
    files: [{ filename: '.github/workflows/ios-tests.yml', status: 'modified', sha: '8'.repeat(40),
      additions: 1, deletions: 1, changes: 2, patch: '@@ -1 +1 @@\n-old\n+new' }] };
  const preserved = JSON.stringify(lineage);
  for (const job of ['budget-e2e-video-processing', 'onboarding-e2e', 'build-ios-e2e-test-products']) {
    const next = changed(job);
    const request: GitHubJsonReader = async (path) => {
      if (path === `commits/${priorHead}`) return { sha: priorHead, parents: [{ sha: oldBase }] };
      if (path === `git/trees/${priorHead}?recursive=1`) return original.tree;
      if (path === `git/trees/${currentHead}?recursive=1`) return next.tree;
      if (path === `git/blobs/${original.sha}`) return original.blob;
      if (path === `git/blobs/${next.sha}`) return next.blob;
      throw new Error(`Unexpected endpoint ${path}`);
    };
    const result = await findEquivalentPatchHead({ pullRequest: pr, currentCommit: commit, previousHead: priorHead,
      priorBaseComparison: { merge_base_commit: { sha: oldBase } },
      initialPriorEffectiveComparison: { status: 'ahead', merge_base_commit: { sha: oldBase }, files: patch },
      currentEffectiveComparison: { status: 'ahead', merge_base_commit: { sha: base }, files: patch },
      currentBaseLineageComparison: lineage,
      comparison: { status: 'ahead', merge_base_commit: { sha: priorHead }, files: lineage.files },
      runs: [{ name: 'Test - iOS', id: 77, run_attempt: 1, head_sha: priorHead, status: 'completed',
        conclusion: 'success', event: 'pull_request', created_at: '2026-09-30T00:00:00Z',
        pull_requests: [{ number: 42, base: { ref: 'develop' } }] }],
      jobsByRunId: { 77: [{ name: 'Test - iOS execution (native3)', id: 1, run_id: 77, run_attempt: 1,
        head_sha: priorHead, status: 'completed', conclusion: 'success' }] },
      timeline: [], workflows: ['Test - iOS'], request, token: undefined });
    if (job === 'budget-e2e-video-processing') {
      assert.ok(result);
      assert.equal(result.priorHead, priorHead);
      assert.deepEqual(result.changedFiles, []);
    } else assert.equal(result, null, job);
    assert.equal(JSON.stringify(lineage), preserved, 'semantic projection must preserve original ancestry/patch comparison');
  }
});

it('planner, cancellation and resumer preserve the same running evidence only for an equivalent workflow', async () => {
  const oldBase = '5'.repeat(40);
  const base = '6'.repeat(40);
  const repository = { full_name: 'example-org/example-app' };
  const pull = { number: 42, state: 'open', draft: false,
    head: { sha: currentHead, ref: 'feature/running-inputs', repo: repository },
    base: { ref: 'develop', sha: base, repo: repository } };
  const commit = { sha: currentHead, parents: [{ sha: priorHead }, { sha: base }],
    commit: { message: 'chore: update PR #42 from develop' } };
  const patch = [{ filename: 'ios/example-ios/App.swift', status: 'modified', sha: '7'.repeat(40),
    additions: 1, deletions: 1, changes: 2, patch: '@@ -1 +1 @@\n-old\n+new' }];
  const lineage = { status: 'ahead', merge_base_commit: { sha: oldBase },
    files: [{ filename: '.github/workflows/ios-tests.yml', status: 'modified', sha: '8'.repeat(40),
      additions: 1, deletions: 1, changes: 2, patch: '@@ -1 +1 @@\n-old\n+new' }] };
  for (const job of ['budget-e2e-video-processing', 'onboarding-e2e', 'build-ios-e2e-test-products']) {
    const next = changed(job);
    const active = { name: 'Test - iOS', id: 123, head_sha: priorHead, status: 'in_progress',
      created_at: '2026-09-30T00:00:00Z', pull_requests: [{ number: 42, base: { ref: 'develop' } }] };
    const request: GitHubJsonReader = async (path) => {
      if (path === `commits/${currentHead}`) return commit;
      if (path === `commits/${priorHead}`) return { sha: priorHead, parents: [{ sha: oldBase }] };
      if (path === `compare/${priorHead}...${currentHead}`) return { status: 'ahead', merge_base_commit: { sha: priorHead }, files: lineage.files };
      if (path === `compare/${base}...${priorHead}`) return { status: 'diverged', merge_base_commit: { sha: oldBase }, files: [] };
      if (path === `compare/${base}...${currentHead}`) return { status: 'ahead', merge_base_commit: { sha: base }, files: patch };
      if (path === `compare/${oldBase}...${priorHead}`) return { status: 'ahead', merge_base_commit: { sha: oldBase }, files: patch };
      if (path === `compare/${oldBase}...${base}`) return lineage;
      if (path === `git/trees/${priorHead}?recursive=1`) return original.tree;
      if (path === `git/trees/${currentHead}?recursive=1`) return next.tree;
      if (path === `git/blobs/${original.sha}`) return original.blob;
      if (path === `git/blobs/${next.sha}`) return next.blob;
      if (path === `actions/runs?event=pull_request&head_sha=${priorHead}&per_page=100`) return { workflow_runs: [active] };
      if (path === 'issues/42/timeline?per_page=100&page=1') return [] as unknown as GitHubJson;
      if (path === 'pulls/42') return pull;
      throw new Error(`Unexpected endpoint ${path}`);
    };
    const expected = job === 'budget-e2e-video-processing';
    assert.equal(await isPatchEquivalentTargetUpdate({ pullRequest: pull as unknown as CancellationObject,
      previousHead: priorHead, request: async (path) => await request(path, undefined) as CancellationObject }), expected);
    assert.equal(await hopByHopLineageEquivalence({ currentCommit: commit as unknown as ResumeObject,
      currentPull: pull as unknown as ResumeObject, deferredBaseSha: base,
      currentEffectiveComparison: { status: 'ahead', merge_base_commit: { sha: base }, files: patch } as unknown as ResumeObject,
      predecessorHead: priorHead, oldBase,
      priorEffectiveComparison: { status: 'ahead', merge_base_commit: { sha: oldBase }, files: patch } as unknown as ResumeObject,
      request: async (path) => await request(path, undefined) as ResumeObject }), expected);
    if (expected) {
      const result = await deltaMain({ event: { action: 'synchronize', before: priorHead, pull_request: pull },
        token: 'fixture-token', workflows: ['Test - iOS'], request });
      assert.deepEqual(result, { deferred: true, predecessorRunId: 123, predecessorRunIds: [123], deferredBaseSha: base });
    }
  }
});
it('unknown or changed runtime inputs never become reusable merely because the workflow matches', async () => {
  let reads = 0;
  const read = async () => { reads += 1; return {}; };
  for (const files of [undefined, [{ filename: 'ios/example-ios/App.swift' }],
    [{ filename: '.github/workflows/ios-tests.yml' }, { filename: 'ci/src/ios/toolchainPolicy.ts' }],
    [{ filename: 'ci/src/ios/changedFileCoverage.ts' }]]) {
    assert.equal(await isReusableIosWorkflowLineage({ comparison: { files }, priorHead, currentHead, read }), false);
  }
  assert.equal(reads, 0);
  assert.equal(await isReusableIosWorkflowLineage({ comparison: { files: [{ filename: 'docs/readme.md' }] }, priorHead, currentHead, read }), true);
});
