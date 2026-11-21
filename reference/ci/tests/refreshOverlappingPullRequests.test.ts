import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';

import { CommitGraph } from './fixtures/commitGraph.ts';

/**
 * Runs the real fan-out controller against a local GitHub double backed by a
 * commit graph, and records every request it makes. A synchronize run must
 * judge every eligible child from its own merge base with the live source tip
 * and never mutate from an obsolete source tip.
 */

const run = promisify(execFile);
const repository = 'example-org/example-app';
const parentBranch = 'codex/stacked-parent';
const parentNumber = 6100;
const childNumber = 7001;
const childBranch = 'codex/stacked-child';

interface Scenario {
  /** Hold the first candidate file reads until this many overlap. */
  readonly candidateReadBarrier?: number;
  readonly graph: CommitGraph;
  readonly eventBefore: string;
  readonly eventAfter: string;
  /** Successive answers for the live source tip; the last one repeats. */
  readonly sourceTips: readonly string[];
  readonly childHead: string;
  readonly childFiles: readonly string[];
  readonly childDraft?: boolean;
  readonly childBase?: string;
  /** The child's live head when it is re-read just before its update. */
  readonly childLiveHead?: string;
  /** Successive live branch refs, independently of the PR snapshot. */
  readonly childBranchTips?: readonly (string | null)[];
  readonly updateBranch?: { readonly status: number; readonly body: unknown };
  /** GitHub's live mergeability for the child, when the controller reads it. */
  readonly childMergeability?: { readonly mergeable: boolean | null; readonly mergeable_state: string };
  /** A protected-base push to this branch instead of a stacked parent's synchronize. */
  readonly pushedBase?: 'develop' | 'main';
  /** Further open pull requests on the same base, beside the child. */
  readonly otherPulls?: readonly OtherPull[];
  /** Pull request numbers GitHub's merge queue for the base holds. */
  readonly mergeQueue?: readonly number[];
  /** How many merge queue reads answer HTTP 503 before one succeeds. */
  readonly mergeQueueFailures?: number;
}

interface OtherPull {
  readonly number: number;
  readonly headSha: string;
  readonly files: readonly string[];
  readonly headRepository?: string;
  readonly mergeability?: { readonly mergeable: boolean | null; readonly mergeable_state: string };
}

const baseOf = (scenario: Scenario): string => scenario.pushedBase ?? parentBranch;

interface Recorded {
  readonly method: string;
  readonly path: string;
  readonly body: string;
}

interface ControllerResult {
  readonly peakCandidateReads: number;
  readonly requests: Recorded[];
  readonly exitCode: number;
  readonly stdout: string;
  readonly summary: string;
  readonly output: string;
}

function send(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, { 'Content-Type': 'application/json' });
  response.end(JSON.stringify(body));
}

async function readBody(request: IncomingMessage): Promise<string> {
  let body = '';
  for await (const chunk of request) body += String(chunk);
  return body;
}

function answer(scenario: Scenario, method: string, path: string, url: URL, sourceTip: () => string, response: ServerResponse): void {
  if (method === 'GET' && path === `pulls/${parentNumber}`) {
    return send(response, 200, { state: 'open', head: { sha: sourceTip(), ref: parentBranch, repo: { full_name: repository } } });
  }
  if (method === 'GET' && path === 'pulls' && url.searchParams.get('base') === baseOf(scenario)) {
    return send(response, 200, [{
      number: childNumber, draft: scenario.childDraft ?? false, user: { login: 'example-user' },
      head: { sha: scenario.childHead, ref: childBranch, repo: { full_name: repository } },
    }, ...(scenario.otherPulls ?? []).map((pull) => ({
      number: pull.number, draft: false, user: { login: 'example-user' },
      head: { sha: pull.headSha, ref: `codex/pr-${pull.number}`, repo: { full_name: pull.headRepository ?? repository } },
    }))]);
  }
  const other = (scenario.otherPulls ?? []).find((pull) => path.startsWith(`pulls/${pull.number}`));
  if (method === 'GET' && other !== undefined && path === `pulls/${other.number}`) {
    return send(response, 200, {
      state: 'open', base: { ref: baseOf(scenario) }, head: { sha: other.headSha, ref: `codex/pr-${other.number}`, repo: { full_name: other.headRepository ?? repository } }, ...other.mergeability,
    });
  }
  if (method === 'GET' && other !== undefined && path === `pulls/${other.number}/files`) {
    return send(response, 200, other.files.map((filename) => ({ filename, status: 'modified' })));
  }
  if (method === 'GET' && path === `pulls/${childNumber}`) {
    return send(response, 200, {
      state: 'open', base: { ref: scenario.childBase ?? baseOf(scenario) }, head: { sha: scenario.childLiveHead ?? scenario.childHead, ref: childBranch, repo: { full_name: repository } },
      ...scenario.childMergeability,
    });
  }
  if (method === 'GET' && path === `pulls/${childNumber}/files`) {
    return send(response, 200, scenario.childFiles.map((filename) => ({ filename, status: 'modified' })));
  }
  const compare = /^compare\/([0-9a-f]{40})\.\.\.([0-9a-f]{40})$/.exec(path);
  if (method === 'GET' && compare?.[1] && compare[2]) {
    try {
      return send(response, 200, scenario.graph.compareNow(compare[1], compare[2]));
    } catch (error: unknown) {
      return send(response, 404, { message: error instanceof Error ? error.message : String(error) });
    }
  }
  if (method === 'GET' && path === 'contents/.github/workflows') return send(response, 200, []);
  if (method === 'GET' && path.startsWith('actions/runs/')) return send(response, 200, { created_at: '2026-09-24T12:00:00Z' });
  if (method === 'GET' && path === `issues/${childNumber}/timeline`) return send(response, 200, [{ event: 'committed' }]);
  if (method === 'GET' && path === 'actions/runs') return send(response, 200, { workflow_runs: [] });
  if (method === 'PUT' && path === `pulls/${childNumber}/update-branch`) {
    // GitHub's documented acceptance: the merge happens later, or not at all.
    return send(response, scenario.updateBranch?.status ?? 202, scenario.updateBranch?.body ?? { message: 'Updating pull request branch.' });
  }
  return send(response, 500, { message: `Unexpected ${method} ${path}` });
}

async function runController(scenario: Scenario): Promise<ControllerResult> {
  const requests: Recorded[] = [];
  let tipReads = 0;
  let childTipReads = 0;
  let activeCandidateReads = 0;
  let peakCandidateReads = 0;
  let barrierReleased = false;
  const waitingCandidates: (() => void)[] = [];
  const barrierTimer = scenario.candidateReadBarrier === undefined ? undefined : setTimeout(() => {
    barrierReleased = true;
    for (const finish of waitingCandidates.splice(0)) finish();
  }, 5000);
  barrierTimer?.unref();
  const currentTip = (): string => scenario.sourceTips[Math.min(tipReads, scenario.sourceTips.length - 1)] ?? '';
  const prefix = `/repos/${repository}/`;
  const server = createServer((request, response) => {
    void (async () => {
      const url = new URL(request.url ?? '/', 'http://localhost');
      const body = await readBody(request);
      const method = request.method ?? 'GET';
      if (method === 'POST' && url.pathname === '/graphql') {
        requests.push({ method, path: 'graphql', body });
        const queueReads = requests.filter((recorded) => recorded.path === 'graphql').length;
        if (queueReads <= (scenario.mergeQueueFailures ?? 0)) return send(response, 503, { message: 'Server Error' });
        const { variables } = JSON.parse(body) as { variables: { branch: string } };
        if (variables.branch !== baseOf(scenario)) {
          return send(response, 500, { message: `Unexpected merge queue branch ${variables.branch}` });
        }
        const numbers = scenario.mergeQueue ?? [];
        return send(response, 200, { data: { repository: { mergeQueue: scenario.mergeQueue === undefined ? null : {
          entries: { totalCount: numbers.length, nodes: numbers.map((number) => ({ pullRequest: { number } })) },
        } } } });
      }
      const path = decodeURIComponent(url.pathname.slice(prefix.length));
      requests.push({ method, path: `${path}${url.search}`, body });
      if (method === 'GET' && path === `git/ref/heads/${parentBranch}`) {
        const tip = currentTip();
        tipReads += 1;
        return send(response, 200, { object: { sha: tip } });
      }
      if (method === 'GET' && path === `git/ref/heads/${childBranch}`) {
        const tips = scenario.childBranchTips ?? [scenario.childLiveHead ?? scenario.childHead];
        const tip = tips[Math.min(childTipReads++, tips.length - 1)];
        return tip === null ? send(response, 404, { message: 'Not Found' })
          : send(response, 200, { object: { sha: tip } });
      }
      const branchPull = (scenario.otherPulls ?? []).find((pull) => path === `git/ref/heads/codex/pr-${pull.number}`);
      if (method === 'GET' && branchPull) return send(response, 200, { object: { sha: branchPull.headSha } });
      if (scenario.candidateReadBarrier !== undefined && method === 'GET' && /^pulls\/\d+\/files$/.test(path)) {
        activeCandidateReads += 1;
        peakCandidateReads = Math.max(peakCandidateReads, activeCandidateReads);
        response.once('finish', () => { activeCandidateReads -= 1; });
        if (!barrierReleased) {
          waitingCandidates.push(() => answer(scenario, method, path, url, currentTip, response));
          if (waitingCandidates.length === scenario.candidateReadBarrier) {
            barrierReleased = true;
            clearTimeout(barrierTimer);
            for (const finish of waitingCandidates.splice(0)) finish();
          }
          return;
        }
      }
      return answer(scenario, method, path, url, currentTip, response);
    })();
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const directory = mkdtempSync(join(tmpdir(), 'example-fan-out-'));
  try {
    const eventPath = join(directory, 'event.json');
    const summaryPath = join(directory, 'summary.md');
    const outputPath = join(directory, 'output.txt');
    writeFileSync(outputPath, '');
    writeFileSync(eventPath, JSON.stringify(scenario.pushedBase ? {
      ref: `refs/heads/${scenario.pushedBase}`,
      before: scenario.eventBefore,
      after: scenario.eventAfter,
      repository: { full_name: repository },
    } : {
      action: 'synchronize',
      before: scenario.eventBefore,
      after: scenario.eventAfter,
      pull_request: {
        number: parentNumber,
        head: { ref: parentBranch, sha: scenario.eventAfter, repo: { full_name: repository } },
      },
    }));
    writeFileSync(summaryPath, '');
    const { port } = server.address() as AddressInfo;
    const { exitCode, stdout } = await run(process.execPath, ['ci/src/actions/refreshOverlappingPullRequests.ts'], {
      env: {
        ...process.env,
        GITHUB_API_URL: `http://127.0.0.1:${port}`,
        GITHUB_GRAPHQL_URL: `http://127.0.0.1:${port}/graphql`,
        GITHUB_EVENT_NAME: scenario.pushedBase ? 'push' : 'pull_request_target',
        GITHUB_EVENT_PATH: eventPath,
        GITHUB_RUN_ID: '42',
        GITHUB_STEP_SUMMARY: summaryPath,
        GITHUB_OUTPUT: outputPath,
        REPOSITORY: repository,
        READ_TOKEN: 'read',
        UPDATE_TOKEN: 'update',
      },
    }).then(
      (result) => ({ exitCode: 0, stdout: result.stdout }),
      (error: unknown) => {
        const failure = error as { code?: unknown; stdout?: unknown; stderr?: unknown };
        if (typeof failure.code !== 'number') throw error;
        return { exitCode: failure.code, stdout: String(failure.stdout ?? '') + String(failure.stderr ?? '') };
      },
    );
    return {
      requests, exitCode, stdout, peakCandidateReads,
      summary: readFileSync(summaryPath, 'utf8'),
      output: readFileSync(outputPath, 'utf8'),
    };
  } finally {
    clearTimeout(barrierTimer);
    server.close();
    rmSync(directory, { recursive: true, force: true });
  }
}

/**
 * Parent A -> B (shared.ts) -> C (other.ts) -> D (other.ts). The child is
 * based on A and edits shared.ts, so only A..B overlaps it.
 */
function lostDelta() {
  const graph = new CommitGraph();
  const root = graph.commit('root', [], { 'shared.ts': '0', 'other.ts': '0' });
  const a = graph.commit('A', [root], { 'shared.ts': '0', 'other.ts': '0', 'parent.ts': 'a' });
  const b = graph.commit('B', [a], { 'shared.ts': 'b', 'other.ts': '0', 'parent.ts': 'a' });
  const c = graph.commit('C', [b], { 'shared.ts': 'b', 'other.ts': 'c', 'parent.ts': 'a' });
  const d = graph.commit('D', [c], { 'shared.ts': 'b', 'other.ts': 'd', 'parent.ts': 'a' });
  const childHead = graph.commit('child', [a], { 'shared.ts': 'child', 'other.ts': '0', 'parent.ts': 'a' });
  return { graph, a, b, c, d, childHead };
}

const mutations = (requests: readonly Recorded[]) =>
  requests.filter((request) => request.method !== 'GET' && request.path !== 'graphql');
const updates = (requests: readonly Recorded[]) =>
  requests.filter((request) => request.method === 'PUT' && request.path === `pulls/${childNumber}/update-branch`);
const updatedHeads = (requests: readonly Recorded[]) =>
  updates(requests).map((request) => (JSON.parse(request.body) as { expected_head_sha: string }).expected_head_sha);

test('the surviving B -> C run updates a child that only overlaps the replaced A -> B change', async () => {
  const { graph, a, b, c, childHead } = lostDelta();
  assert.deepEqual(graph.changedFiles({ before: b, after: c }), ['other.ts']);
  const result = await runController({
    graph, eventBefore: b, eventAfter: c, sourceTips: [c], childHead, childFiles: ['shared.ts'],
  });
  assert.deepEqual(updatedHeads(result.requests), [childHead]);
  assert.ok(result.requests.some((request) => request.path === `compare/${a}...${c}`));
  assert.ok(!result.requests.some((request) => request.path.startsWith('git/ref/') && !request.path.startsWith('git/ref/heads/')),
    'no hidden ref is read');
});

test('an A-based child opened after the parent reached B is judged on A..C at the next push', async () => {
  // The parent's B push ran before this child existed, so nothing judged it on
  // A..B. Its first chance is B -> C, whose own range misses shared.ts.
  const { graph, b, c, childHead } = lostDelta();
  const result = await runController({
    graph, eventBefore: b, eventAfter: c, sourceTips: [c], childHead, childFiles: ['shared.ts'],
  });
  assert.deepEqual(updatedHeads(result.requests), [childHead]);
  assert.match(result.summary, /#7001 \(1 shared file\(s\): shared\.ts\): updating/);
});

test('a draft A-based child that becomes ready after B is selected at the next push', async () => {
  const { graph, b, c, d, childHead } = lostDelta();
  const whileDraft = await runController({
    graph, eventBefore: b, eventAfter: c, sourceTips: [c], childHead, childFiles: ['shared.ts'], childDraft: true,
  });
  assert.deepEqual(updates(whileDraft.requests), [], 'an ordinary push leaves a draft to its author');

  const onceReady = await runController({
    graph, eventBefore: c, eventAfter: d, sourceTips: [d], childHead, childFiles: ['shared.ts'],
  });
  assert.deepEqual(graph.changedFiles({ before: c, after: d }), ['other.ts']);
  assert.deepEqual(updatedHeads(onceReady.requests), [childHead]);
});

test('an accepted update that never lands leaves the child selectable at the next push', async () => {
  const { graph, a, b, c, d, childHead } = lostDelta();
  const accepted = await runController({
    graph, eventBefore: b, eventAfter: c, sourceTips: [c], childHead, childFiles: ['shared.ts'],
  });
  assert.deepEqual(updatedHeads(accepted.requests), [childHead]);

  // The merge behind that 202 failed: the child head never moved. C -> D
  // touches only other.ts, but the child's own merge base still reaches A..B.
  const next = await runController({
    graph, eventBefore: c, eventAfter: d, sourceTips: [d], childHead, childFiles: ['shared.ts'],
  });
  assert.deepEqual(updatedHeads(next.requests), [childHead]);
  assert.ok(next.requests.some((request) => request.path === `compare/${a}...${d}`));

  // Once a merge really lands the child contains D and drops out.
  const merged = graph.commit('child merged D', [childHead, d], { 'shared.ts': 'child', 'other.ts': 'd', 'parent.ts': 'a' });
  const settled = await runController({
    graph, eventBefore: c, eventAfter: d, sourceTips: [d], childHead: merged, childFiles: ['shared.ts'],
  });
  assert.deepEqual(updates(settled.requests), []);
  assert.match(settled.summary, /Already contain [0-9a-f]{7}, so nothing to merge: #7001/);
});

test('a child that shares nothing with its pending range is left alone', async () => {
  const { graph, b, c, childHead } = lostDelta();
  const result = await runController({
    graph, eventBefore: b, eventAfter: c, sourceTips: [c], childHead, childFiles: ['child-only.ts'],
  });
  assert.deepEqual(updates(result.requests), []);
});

test('an active run for an obsolete source tip mutates nothing', async () => {
  const { graph, b, c, d, childHead } = lostDelta();
  const result = await runController({
    graph, eventBefore: b, eventAfter: c, sourceTips: [d], childHead, childFiles: ['shared.ts'],
  });
  assert.deepEqual(mutations(result.requests), []);
  assert.match(result.stdout, /::notice::Skipped fan-out .* moved to/);
  assert.ok(!result.requests.some((request) => request.path.startsWith('pulls?')), 'no child inventory is read');
});

test('a source that moves mid-run stops before the next child mutation', async () => {
  const { graph, b, c, d, childHead } = lostDelta();
  const result = await runController({
    graph, eventBefore: b, eventAfter: c, sourceTips: [c, d], childHead, childFiles: ['shared.ts'],
  });
  assert.deepEqual(mutations(result.requests), []);
  assert.match(result.summary, /Stopped before #7001: .*moved to [0-9a-f]{40}/);
});

test('a child retargeted after it was judged is not updated', async () => {
  const { graph, b, c, childHead } = lostDelta();
  const result = await runController({
    graph, eventBefore: b, eventAfter: c, sourceTips: [c], childHead, childFiles: ['shared.ts'], childBase: 'develop',
  });
  assert.deepEqual(updates(result.requests), []);
  assert.match(result.summary, /#7001: not updated because it now targets develop/);
});

test('a child whose head moved after inventory is skipped and selected again from its new head', async () => {
  const { graph, b, c, childHead } = lostDelta();
  const movedChild = graph.commit('moved child', [childHead], { 'shared.ts': 'child2', 'other.ts': '0', 'parent.ts': 'a' });
  const result = await runController({
    graph, eventBefore: b, eventAfter: c, sourceTips: [c], childHead, childLiveHead: movedChild, childFiles: ['shared.ts'],
  });
  assert.deepEqual(updates(result.requests), []);
  assert.match(result.summary, /#7001: not updated because its head moved/);

  const next = await runController({
    graph, eventBefore: b, eventAfter: c, sourceTips: [c], childHead: movedChild, childFiles: ['shared.ts'],
  });
  assert.deepEqual(updatedHeads(next.requests), [movedChild]);
});

test('an update-branch head race fails the run and a conflict is reported', async () => {
  const { graph, b, c, childHead } = lostDelta();
  const raced = await runController({
    graph, eventBefore: b, eventAfter: c, sourceTips: [c], childHead, childFiles: ['shared.ts'],
    updateBranch: { status: 422, body: { message: "expected head sha didn't match current head ref." } },
  });
  assert.equal(raced.exitCode, 1);
  assert.match(raced.summary, /#7001 .*: error HTTP 422/);

  const conflicted = await runController({
    graph, eventBefore: b, eventAfter: c, sourceTips: [c], childHead, childFiles: ['shared.ts'],
    updateBranch: { status: 422, body: { message: 'merge conflict between base and head' } },
  });
  assert.equal(conflicted.exitCode, 0);
  assert.match(conflicted.stdout, /::warning::Pull request #7001 now conflicts with codex\/stacked-parent on shared\.ts/);
});

const conflictedOutput = (output: string): unknown => {
  const key = 'conflicted_pull_requests=';
  const line = output.split('\n').find((entry) => entry.startsWith(key));
  return line === undefined ? undefined : JSON.parse(line.slice(key.length));
};

test('an Update Branch conflict publishes the exact conflicted head for run cleanup', async () => {
  const { graph, b, c, childHead } = lostDelta();
  const conflicted = await runController({
    graph, eventBefore: b, eventAfter: c, sourceTips: [c], childHead, childFiles: ['shared.ts'],
    updateBranch: { status: 422, body: { message: 'merge conflict between base and head' } },
  });
  assert.equal(conflicted.exitCode, 0);
  assert.deepEqual(conflictedOutput(conflicted.output), [
    { number: childNumber, headRef: childBranch, headSha: childHead },
  ]);
});

test('accepted, already-current and failed updates publish no conflicted pull request', async () => {
  const { graph, b, c, childHead } = lostDelta();
  for (const updateBranch of [
    undefined,
    { status: 422, body: { message: 'There are no new commits on the base branch.' } },
    { status: 422, body: { message: "expected head sha didn't match current head ref." } },
  ]) {
    const result = await runController({
      graph, eventBefore: b, eventAfter: c, sourceTips: [c], childHead, childFiles: ['shared.ts'],
      ...(updateBranch === undefined ? {} : { updateBranch }),
    });
    assert.ok(updates(result.requests).length === 1, JSON.stringify(updateBranch));
    assert.equal(result.output, '', JSON.stringify(updateBranch));
  }
});

/** The parent's B edits only a generated artifact the child also edits. */
function generatedOverlap() {
  const graph = new CommitGraph();
  const generated = 'server/generated/api.ts';
  const a = graph.commit('A', [], { [generated]: '0', 'parent.ts': 'a' });
  const b = graph.commit('B', [a], { [generated]: 'b', 'parent.ts': 'a' });
  const childHead = graph.commit('child', [a], { [generated]: 'child', 'parent.ts': 'a' });
  return { graph, a, b, childHead, generated };
}

test('a generated-only overlap GitHub reports dirty is published as conflicted', async () => {
  const { graph, a, b, childHead, generated } = generatedOverlap();
  const result = await runController({
    graph, eventBefore: a, eventAfter: b, sourceTips: [b], childHead, childFiles: [generated],
    childMergeability: { mergeable: false, mergeable_state: 'dirty' },
  });
  assert.deepEqual(updates(result.requests), []);
  assert.match(result.stdout, /::warning::#7001: conflicts with codex\/stacked-parent on server\/generated\/api\.ts/);
  assert.deepEqual(conflictedOutput(result.output), [
    { number: childNumber, headRef: childBranch, headSha: childHead },
  ]);
});

test('a clean generated-only overlap publishes no conflicted pull request', async () => {
  const { graph, a, b, childHead, generated } = generatedOverlap();
  const result = await runController({
    graph, eventBefore: a, eventAfter: b, sourceTips: [b], childHead, childFiles: [generated],
    childMergeability: { mergeable: true, mergeable_state: 'clean' },
  });
  assert.deepEqual(updates(result.requests), []);
  assert.equal(result.output, '');
});

/** develop A -> B edits shared.ts; the pull request forked from A also edits it. */
function developOverlap() {
  const graph = new CommitGraph();
  const a = graph.commit('A', [], { 'shared.ts': '0', 'other.ts': '0' });
  const b = graph.commit('B', [a], { 'shared.ts': 'b', 'other.ts': '0' });
  const childHead = graph.commit('pr', [a], { 'shared.ts': 'pr', 'other.ts': '0' });
  return { graph, a, b, childHead };
}

test('a develop push that overlaps a pull request without conflict merges nothing', async () => {
  const { graph, a, b, childHead } = developOverlap();
  const result = await runController({
    graph, pushedBase: 'develop', eventBefore: a, eventAfter: b, sourceTips: [b], childHead, childFiles: ['shared.ts'],
    childMergeability: { mergeable: true, mergeable_state: 'clean' },
  });
  assert.equal(result.exitCode, 0);
  assert.deepEqual(mutations(result.requests), []);
  assert.equal(result.output, '');
  assert.match(result.stdout, /^base-update: pr=#7001 action=skip reason=no-conflict$/m);
  assert.match(result.summary, /`base-update: pr=#7001 action=skip reason=no-conflict`/);
});

test('a develop push that leaves a pull request in conflict reports it without merging', async () => {
  const { graph, a, b, childHead } = developOverlap();
  const result = await runController({
    graph, pushedBase: 'develop', eventBefore: a, eventAfter: b, sourceTips: [b], childHead, childFiles: ['shared.ts'],
    childMergeability: { mergeable: false, mergeable_state: 'dirty' },
  });
  assert.equal(result.exitCode, 0);
  assert.deepEqual(mutations(result.requests), []);
  assert.match(result.stdout, /::warning::#7001: conflicts with develop on shared\.ts/);
  assert.match(result.stdout, /^base-update: pr=#7001 action=report reason=conflict$/m);
  assert.deepEqual(conflictedOutput(result.output), [
    { number: childNumber, headRef: childBranch, headSha: childHead },
  ]);
});

const mergeabilityReads = (requests: readonly Recorded[]) =>
  requests.filter((request) => request.method === 'GET' && request.path === `pulls/${childNumber}`);

test('uncomputed mergeability is read once, skipped and reported without waiting', async () => {
  const { graph, a, b, childHead } = developOverlap();
  for (const childMergeability of [
    { mergeable: null, mergeable_state: 'unknown' },
    { mergeable: false, mergeable_state: 'unknown' },
  ]) {
    const result = await runController({
      graph, pushedBase: 'develop', eventBefore: a, eventAfter: b, sourceTips: [b], childHead, childFiles: ['shared.ts'],
      childMergeability,
    });
    assert.equal(result.exitCode, 0);
    assert.equal(mergeabilityReads(result.requests).length, 1, 'no retry or poll of mergeability');
    assert.deepEqual(mutations(result.requests), []);
    assert.equal(result.output, '');
    assert.match(result.stdout, /^base-update: pr=#7001 action=skip reason=mergeability-unknown$/m);
  }
});

test('a develop push reports a pull request that shares nothing as no-overlap', async () => {
  const { graph, a, b, childHead } = developOverlap();
  const result = await runController({
    graph, pushedBase: 'develop', eventBefore: a, eventAfter: b, sourceTips: [b], childHead, childFiles: ['pr-only.ts'],
  });
  assert.deepEqual(mutations(result.requests), []);
  assert.ok(!result.requests.some((request) => request.path === `pulls/${childNumber}`), 'no mergeability read');
  assert.match(result.stdout, /^base-update: pr=#7001 action=skip reason=no-overlap$/m);
});

test('a develop iOS source change refreshes an iOS PR whose native product includes that source', async () => {
  const graph = new CommitGraph();
  const basePath = 'ios/example-ios/UI/Components/InteractiveRetirementProjectionView.swift';
  const prPath = 'ios/example-ios/UI/Cards/Profile/Profile1View.swift';
  const a = graph.commit('A', [], { [basePath]: 'old', [prPath]: 'old' });
  const b = graph.commit('B', [a], { [basePath]: 'new', [prPath]: 'old' });
  const childHead = graph.commit('pr', [a], { [basePath]: 'old', [prPath]: 'changed' });
  const result = await runController({
    graph, pushedBase: 'develop', eventBefore: a, eventAfter: b, sourceTips: [b],
    childHead, childFiles: [prPath],
  });
  assert.equal(result.exitCode, 0);
  assert.deepEqual(updatedHeads(result.requests), [childHead]);
  assert.match(result.stdout, /^base-update: pr=#7001 action=update reason=ios-base-input result=updating$/m);
});

test('a main push still merges an overlapping pull request', async () => {
  const { graph, a, b, childHead } = developOverlap();
  const result = await runController({
    graph, pushedBase: 'main', eventBefore: a, eventAfter: b, sourceTips: [b], childHead, childFiles: ['shared.ts'],
  });
  assert.deepEqual(updatedHeads(result.requests), [childHead]);
  assert.match(result.stdout, /^base-update: pr=#7001 action=update reason=overlap result=updating$/m);
});

const headOf = (digit: string): string => digit.repeat(40);

test('a develop push acts only on the pull request it leaves in conflict', async () => {
  const { graph, a, b, childHead } = developOverlap();
  const clean = 7002;
  const unknown = 7003;
  const queued = 7004;
  const fork = 7005;
  const untouched = 7006;
  const dirty = { mergeable: false, mergeable_state: 'dirty' } as const;
  const result = await runController({
    graph, pushedBase: 'develop', eventBefore: a, eventAfter: b, sourceTips: [b], childHead, childFiles: ['shared.ts'],
    childMergeability: dirty,
    otherPulls: [
      { number: clean, headSha: headOf('2'), files: ['shared.ts'], mergeability: { mergeable: true, mergeable_state: 'clean' } },
      { number: unknown, headSha: headOf('3'), files: ['shared.ts'], mergeability: { mergeable: null, mergeable_state: 'unknown' } },
      { number: queued, headSha: headOf('4'), files: ['shared.ts'], mergeability: dirty },
      { number: fork, headSha: headOf('5'), files: ['shared.ts'], headRepository: 'someone/example-app', mergeability: dirty },
      { number: untouched, headSha: headOf('6'), files: ['pr-only.ts'] },
    ],
    mergeQueue: [queued],
  });
  assert.equal(result.exitCode, 0);
  assert.deepEqual(mutations(result.requests), [], 'no pull request is updated');
  assert.equal(result.requests.filter((request) => request.path === 'graphql').length, 1, 'the queue is read once');
  assert.deepEqual(conflictedOutput(result.output), [
    { number: childNumber, headRef: childBranch, headSha: childHead },
  ], 'only the conflicting pull request reaches conflict cleanup');
  const mergeabilityRead = (number: number) => result.requests.some((request) => request.path === `pulls/${number}`);
  assert.deepEqual([childNumber, clean, unknown, queued, fork, untouched].filter(mergeabilityRead), [childNumber, clean, unknown]);
  for (const line of [
    `pr=#${childNumber} action=report reason=conflict`,
    `pr=#${clean} action=skip reason=no-conflict`,
    `pr=#${unknown} action=skip reason=mergeability-unknown`,
    `pr=#${queued} action=skip reason=in-merge-queue`,
    `pr=#${fork} action=skip reason=ineligible`,
    `pr=#${untouched} action=skip reason=no-overlap`,
  ]) assert.match(result.stdout, new RegExp(`^base-update: ${line}$`, 'm'));
  assert.equal((result.stdout.match(/^base-update: /gm) ?? []).length, 6, 'one decision line per pull request');
});

test('a develop push that repairs CI or adds a workflow executable updates nothing and reads no check runs', async () => {
  const graph = new CommitGraph();
  const workflow = '.github/workflows/pr-checks.yml';
  const a = graph.commit('A', [], { 'ci/src/prValidationPlan.ts': '0', [workflow]: '0' });
  const b = graph.commit('B', [a], {
    'ci/src/prValidationPlan.ts': 'fix', [workflow]: 'run: node ci/src/actions/newStep.ts', 'ci/src/actions/newStep.ts': 'new',
  });
  const childHead = graph.commit('pr', [a], { 'ci/src/prValidationPlan.ts': '0', [workflow]: '0', 'pr.ts': 'pr' });
  const result = await runController({
    graph, pushedBase: 'develop', eventBefore: a, eventAfter: b, sourceTips: [b], childHead, childFiles: ['pr.ts'],
  });
  assert.equal(result.exitCode, 0);
  assert.deepEqual(mutations(result.requests), []);
  assert.ok(!result.requests.some((request) => /check-runs|^contents\//.test(request.path)),
    'no failed-check, workflow or executable inventory is read on develop');
  assert.ok(!result.requests.some((request) => request.path === 'graphql'), 'nothing to act on, so no queue read');
  assert.match(result.stdout, /^base-update: pr=#7001 action=skip reason=no-overlap$/m);
  assert.match(result.summary, /develop updates a pull request only when a changed native iOS execution input/);
});

test('a transient merge queue read failure is retried within the read budget', async () => {
  const { graph, a, b, childHead } = developOverlap();
  const scenario = {
    graph, pushedBase: 'develop', eventBefore: a, eventAfter: b, sourceTips: [b], childHead, childFiles: ['shared.ts'],
    childMergeability: { mergeable: false, mergeable_state: 'dirty' }, mergeQueue: [],
  } as const;
  const recovered = await runController({ ...scenario, mergeQueueFailures: 1 });
  assert.equal(recovered.exitCode, 0);
  assert.equal(recovered.requests.filter((request) => request.path === 'graphql').length, 2);
  assert.match(recovered.stdout, /^base-update: pr=#7001 action=report reason=conflict$/m);

  const exhausted = await runController({ ...scenario, mergeQueueFailures: 10 });
  assert.notEqual(exhausted.exitCode, 0);
  assert.equal(exhausted.requests.filter((request) => request.path === 'graphql').length, 3, 'bounded retries');
  assert.equal(exhausted.output, '', 'nothing is reported from an unread queue');
});

test('a main push leaves a queued pull request to the queue', async () => {
  const { graph, a, b, childHead } = developOverlap();
  const result = await runController({
    graph, pushedBase: 'main', eventBefore: a, eventAfter: b, sourceTips: [b], childHead, childFiles: ['shared.ts'],
    mergeQueue: [childNumber],
  });
  assert.deepEqual(mutations(result.requests), []);
  assert.match(result.stdout, /^base-update: pr=#7001 action=skip reason=in-merge-queue$/m);
});

test('a frozen PR snapshot fails with exact refs before evidence scans or native updates', async () => {
  const { graph, b, c, childHead } = lostDelta();
  for (const tip of [c, null]) {
    const result = await runController({
      graph, eventBefore: b, eventAfter: c, sourceTips: [c], childHead,
      childFiles: ['shared.ts'], childBranchTips: [tip],
    });
    assert.equal(result.exitCode, 1);
    assert.deepEqual(mutations(result.requests), []);
    assert.ok(!result.requests.some((request) => request.path.startsWith(`issues/${childNumber}/timeline`)));
    assert.ok(!result.requests.some((request) => request.path.startsWith('actions/runs?')));
    assert.ok(result.summary.includes(childHead));
    assert.ok(result.summary.includes(tip ?? 'deleted'));
    assert.match(result.summary, /action=report reason=head-ref-incoherent/);
    assert.doesNotMatch(result.summary, /Re-run this workflow/);
  }
});

test('a branch that moves after evidence scanning cannot receive an update for the old PR snapshot', async () => {
  const { graph, b, c, childHead } = lostDelta();
  const result = await runController({
    graph, eventBefore: b, eventAfter: c, sourceTips: [c], childHead,
    childFiles: ['shared.ts'], childBranchTips: [childHead, c],
  });
  assert.equal(result.exitCode, 1);
  assert.deepEqual(mutations(result.requests), []);
  assert.ok(result.requests.some((request) => request.path.startsWith(`issues/${childNumber}/timeline`)));
  assert.match(result.summary, /action=report reason=head-ref-incoherent/);
});

test('real discovery overlaps four candidate reads, shares the range and keeps native mutation boundaries', async () => {
  const { graph, a, b, childHead } = lostDelta();
  const result = await runController({ graph, pushedBase: 'develop', eventBefore: a, eventAfter: b,
    sourceTips: [b], childHead, childFiles: ['shared.ts'], candidateReadBarrier: 4,
    childMergeability: { mergeable: true, mergeable_state: 'clean' },
    otherPulls: Array.from({ length: 7 }, (_, index) => ({ number: childNumber + index + 1,
      headSha: childHead, files: ['shared.ts'], mergeability: { mergeable: true, mergeable_state: 'clean' } })),
  });
  assert.equal(result.exitCode, 0, result.stdout);
  assert.equal(result.peakCandidateReads, 4, 'candidate discovery must overlap, stay bounded and drain each batch');
  assert.equal(result.requests.filter(request => request.path === `compare/${a}...${b}`).length, 1,
    'concurrent candidates share one exact-range read');
  assert.equal(result.requests.filter(request => /^pulls\/\d+\/files\?/.test(request.path)).length, 8);
  assert.deepEqual(mutations(result.requests), [], 'discovery must not become a parallel mutation authority');
});
