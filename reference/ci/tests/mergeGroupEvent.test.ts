import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, it } from 'node:test';

import {
  CiEventError, projectCiEvent, readMergeGroupEvent, reviewedHeadApiPath, reviewedHeadGitRef,
  reviewedHeadShaFromApi, reviewedHeadSource, type MergeGroupEventTuple,
} from '../src/ciEvent.ts';
import {
  MAX_QUEUE_ENTRIES, reverifyMergeGroupCandidate, verifyMergeGroupCandidate,
} from '../src/mergeGroupCandidate.ts';
import { readMergeGroupInventory } from '../src/mergeGroupInventory.ts';
import { MergeQueueCandidateGone } from '../src/mergeQueueCandidateGone.ts';
import { queueRefDecision } from '../src/ios/currentPullRequestTuple.ts';
import { detectEarlyExitOutputs } from '../src/ios/iosChangeGate.ts';
import { deriveNativeTestLaneStatus, type NativeTestLaneStatusInput } from '../src/ios/nativeTestLaneStatus.ts';
import { deriveRealServerE2eStatus, type RealServerE2eStatusInput } from '../src/ios/realServerE2eStatus.ts';
import { decisionErrors, renderStepMessage } from '../src/ios/shared/stepDecision.ts';
import { GithubTransportError, type GithubReader, type GithubResponse } from '../src/ios/shared/githubRest.ts';
import { prValidationLaneReasons, type PrValidationVerdictInput } from '../src/prValidationVerdict.ts';

const BASE = 'b'.repeat(40);
const CANDIDATE = 'c'.repeat(40);
const PR_HEAD = 'd'.repeat(40);
const PREVIOUS_CANDIDATE = 'a'.repeat(40);
const REPOSITORY = 'example-org/example-app';
/** GitHub delivers `merge_group.head_ref` fully qualified. */
const QUEUE_REF = `refs/heads/gh-readonly-queue/develop/pr-6151-${'9'.repeat(40)}`;

function payload(group: Record<string, unknown> = {}): unknown {
  return {
    action: 'checks_requested',
    merge_group: {
      head_sha: CANDIDATE, base_sha: BASE, head_ref: QUEUE_REF, base_ref: 'refs/heads/develop',
      head_commit: { id: CANDIDATE },
      ...group,
    },
    repository: { full_name: REPOSITORY },
  };
}

function mergeGroup(): MergeGroupEventTuple {
  const event = projectCiEvent('merge_group', payload(), CANDIDATE);
  assert.equal(event.kind, 'merge_group');
  return event;
}

describe('merge_group payload projection', () => {
  it('maps a realistic payload to the candidate and the queue base', () => {
    assert.deepEqual(projectCiEvent('merge_group', payload(), CANDIDATE), {
      kind: 'merge_group',
      prNumber: '6151',
      headSha: CANDIDATE,
      trustedBaseSha: BASE,
      baseBranch: 'develop',
      queueRef: QUEUE_REF,
      repository: REPOSITORY,
    });
  });

  it('never takes the trusted base from the event commit', () => {
    const event = mergeGroup();
    assert.notEqual(event.trustedBaseSha, CANDIDATE);
    assert.throws(() => projectCiEvent('merge_group', payload({ base_sha: CANDIDATE }), CANDIDATE),
      /head_sha equals base_sha/);
    assert.throws(() => projectCiEvent('merge_group', payload(), PR_HEAD),
      /is not the payload candidate/);
  });

  for (const [label, group, pattern] of [
    ['a short head SHA', { head_sha: 'c'.repeat(39) }, /merge_group\.head_sha must be a 40-character/],
    ['an uppercase base SHA', { base_sha: 'B'.repeat(40) }, /merge_group\.base_sha/],
    ['a missing base SHA', { base_sha: undefined }, /merge_group\.base_sha/],
    ['an unqualified queue ref', { head_ref: QUEUE_REF.slice('refs/heads/'.length) }, /merge_group\.head_ref/],
    ['a doubly qualified queue ref', { head_ref: `refs/heads/${QUEUE_REF}` }, /merge_group\.head_ref/],
    ['a queue ref for main', { head_ref: QUEUE_REF.replace('/develop/', '/main/') }, /merge_group\.head_ref/],
    ['a queue ref without a PR number', { head_ref: `refs/heads/gh-readonly-queue/develop/pr-0-${BASE}` }, /head_ref/],
    ['a main base', { base_ref: 'refs/heads/main' }, /merge_group\.base_ref/],
  ] as const) {
    it(`rejects ${label}`, () => {
      assert.throws(() => projectCiEvent('merge_group', payload(group), CANDIDATE), (error: unknown) =>
        error instanceof CiEventError && pattern.test(error.message));
    });
  }

  it('maps each supported event explicitly and refuses any other', () => {
    const pull = projectCiEvent('pull_request', {
      pull_request: {
        number: 7, draft: true,
        head: { sha: PR_HEAD, ref: 'feature/x', repo: null },
        base: { sha: BASE, ref: 'develop' },
      },
      repository: { full_name: REPOSITORY },
    }, CANDIDATE);
    assert.deepEqual(pull, {
      kind: 'pull_request', prNumber: '7', headSha: PR_HEAD, trustedBaseSha: BASE,
      baseBranch: 'develop', headRepository: '', draft: true,
    });
    assert.deepEqual(projectCiEvent('workflow_dispatch', {}, CANDIDATE), {
      kind: 'workflow_dispatch', headSha: CANDIDATE,
    });
    assert.throws(() => projectCiEvent('push', {}, CANDIDATE), /Unsupported CI event: push/);
  });

  it('reads the job event file only on merge_group', () => {
    const directory = mkdtempSync(join(tmpdir(), 'merge-group-event-'));
    const eventPath = join(directory, 'event.json');
    writeFileSync(eventPath, JSON.stringify(payload()));
    assert.equal(readMergeGroupEvent({ GITHUB_EVENT_NAME: 'pull_request', GITHUB_EVENT_PATH: eventPath }), undefined);
    assert.deepEqual(
      readMergeGroupEvent({ GITHUB_EVENT_NAME: 'merge_group', GITHUB_EVENT_PATH: eventPath, GITHUB_SHA: CANDIDATE }),
      mergeGroup(),
    );
  });

  it('addresses the queue ref exactly once qualified in Git and in the REST API', () => {
    const source = reviewedHeadSource('', QUEUE_REF);
    assert.equal(reviewedHeadGitRef(source), QUEUE_REF);
    assert.equal(reviewedHeadApiPath(source), `/git/ref/heads/gh-readonly-queue/develop/pr-6151-${'9'.repeat(40)}`);
    assert.doesNotMatch(reviewedHeadApiPath(source), /refs\/heads|heads\/refs|heads\/heads/);
    assert.equal(reviewedHeadShaFromApi(source, { object: { sha: CANDIDATE } }), CANDIDATE);
    const pull = reviewedHeadSource('7', '');
    assert.equal(reviewedHeadGitRef(pull), 'refs/pull/7/head');
    assert.equal(reviewedHeadApiPath(pull), '/pulls/7');
    assert.throws(() => reviewedHeadSource('7', QUEUE_REF), /not both/);
    assert.throws(() => reviewedHeadSource('', ''), /positive PR number or a merge queue ref/);
    assert.throws(() => reviewedHeadSource('', 'refs/heads/develop'), /Not a develop merge queue ref/);
  });
});

function response(status: number, body: unknown): GithubResponse {
  return { status, statusLabel: String(status), body };
}

interface FakeCommit {
  readonly message: string;
  readonly parents: readonly string[];
}
interface FakePull {
  readonly state?: string;
  readonly draft?: boolean;
  readonly base?: { readonly ref: string };
  readonly head: { readonly sha: string; readonly repo: { readonly full_name: string } | null };
}
interface FakeRepository {
  readonly commits: Record<string, FakeCommit>;
  readonly pulls: Record<string, FakePull>;
}

const merge = (pr: string, firstParent: string, head: string): FakeCommit => ({
  message: `Merge pull request #${pr} from example-org/branch-${pr}\n\nTitle`,
  parents: [firstParent, head],
});
const sameRepoPull = (sha: string): FakePull => ({ head: { sha, repo: { full_name: REPOSITORY } } });

/** A first entry: the candidate merges PR #6151 onto the queue base. */
function firstEntry(): FakeRepository {
  return {
    commits: { [CANDIDATE]: merge('6151', BASE, PR_HEAD) },
    pulls: { '6151': sameRepoPull(PR_HEAD) },
  };
}

/** A second entry: PR #6150 at entry 1, PR #6151 on top of that candidate. */
const OTHER_HEAD = 'e'.repeat(40);
function secondEntry(): FakeRepository {
  return {
    commits: {
      [CANDIDATE]: merge('6151', PREVIOUS_CANDIDATE, PR_HEAD),
      [PREVIOUS_CANDIDATE]: merge('6150', BASE, OTHER_HEAD),
    },
    pulls: { '6151': sameRepoPull(PR_HEAD), '6150': sameRepoPull(OTHER_HEAD) },
  };
}

function reader(repository: FakeRepository): GithubReader {
  const prefix = `https://api.github.com/repos/${REPOSITORY}`;
  return async (url: string) => {
    if (!url.startsWith(prefix)) return response(404, undefined);
    const pull = /\/pulls\/(\d+)$/.exec(url)?.[1];
    const livePull = pull === undefined ? undefined : repository.pulls[pull];
    if (livePull !== undefined) {
      return response(200, { state: 'open', draft: false, base: { ref: 'develop' }, ...livePull });
    }
    const sha = /\/commits\/([0-9a-f]{40})$/.exec(url)?.[1];
    if (sha === undefined) return response(404, undefined);
    const commit = repository.commits[sha] ?? { message: 'ordinary commit', parents: [BASE] };
    return response(200, {
      commit: { message: commit.message }, parents: commit.parents.map((parent) => ({ sha: parent })),
    });
  };
}

async function verify(repository = firstEntry()) {
  return verifyMergeGroupCandidate(mergeGroup(), 'https://api.github.com', reader(repository));
}

async function rejection(repository: FakeRepository): Promise<string> {
  const verdict = await verify(repository);
  assert.equal(verdict.kind, 'rejected');
  return verdict.kind === 'rejected' ? verdict.reason : '';
}

describe('merge queue candidate proof', () => {
  it('verifies a first queue entry merged onto the queue base', async () => {
    assert.deepEqual(await verify(), {
      kind: 'verified',
      candidate: {
        prNumber: '6151', prHeadSha: PR_HEAD, queueBaseSha: BASE, candidateSha: CANDIDATE, queueRef: QUEUE_REF,
        entries: [{ prNumber: '6151', prHeadSha: PR_HEAD, entrySha: CANDIDATE }],
      },
    });
  });

  it('verifies a 2-entry cumulative candidate whose entries are all same-repository PRs', async () => {
    const verdict = await verify(secondEntry());
    assert.equal(verdict.kind, 'verified');
    assert.deepEqual(verdict.kind === 'verified' && verdict.candidate.entries, [
      { prNumber: '6150', prHeadSha: OTHER_HEAD, entrySha: PREVIOUS_CANDIDATE },
      { prNumber: '6151', prHeadSha: PR_HEAD, entrySha: CANDIDATE },
    ]);
  });

  it('rejects a 2-entry candidate whose first entry is a fork PR', async () => {
    const repository = secondEntry();
    repository.pulls['6150'] = { head: { sha: OTHER_HEAD, repo: { full_name: 'outside/fork' } } };
    assert.equal(await rejection(repository), 'fork-head');
  });

  it('rejects a first entry whose PR has moved since it was queued', async () => {
    const repository = secondEntry();
    repository.pulls['6150'] = sameRepoPull('9'.repeat(40));
    assert.equal(await rejection(repository), 'candidate-last-parent-not-pr-head');
  });

  it('rejects a first-parent chain that does not end at the queue base', async () => {
    const repository = secondEntry();
    repository.commits[PREVIOUS_CANDIDATE] = merge('6150', '8'.repeat(40), OTHER_HEAD);
    assert.equal(await rejection(repository), 'candidate-chain-does-not-reach-base');
  });

  it('rejects a chain longer than the queue can build', async () => {
    const commits: Record<string, FakeCommit> = {};
    let sha = CANDIDATE;
    for (let index = 0; index <= MAX_QUEUE_ENTRIES; index += 1) {
      const parent = index.toString(16).padStart(40, '7');
      commits[sha] = merge('6151', parent, PR_HEAD);
      sha = parent;
    }
    assert.equal(await rejection({ commits, pulls: { '6151': sameRepoPull(PR_HEAD) } }),
      'candidate-chain-does-not-reach-base');
  });

  it('rejects a top entry that merges a different PR than the queue ref names', async () => {
    const repository = firstEntry();
    repository.commits[CANDIDATE] = merge('7', BASE, PR_HEAD);
    repository.pulls['7'] = sameRepoPull(PR_HEAD);
    assert.equal(await rejection(repository), 'candidate-top-entry-not-queued-pr');
  });

  it('rejects a squash or rebase candidate, which has no PR-head parent', async () => {
    const repository = firstEntry();
    repository.commits[CANDIDATE] = { message: 'Title (#6151)', parents: [BASE] };
    assert.equal(await rejection(repository), 'candidate-entry-not-a-queue-merge');
  });

  for (const [label, pull, reason] of [
    ['a closed PR', { state: 'closed' }, 'pull-request-not-open'],
    ['a draft PR', { draft: true }, 'pull-request-draft'],
    ['a PR into main', { base: { ref: 'main' } }, 'pull-request-wrong-base'],
    ['a fork head', { head: { sha: PR_HEAD, repo: { full_name: 'outside/fork' } } }, 'fork-head'],
    ['a deleted fork head', { head: { sha: PR_HEAD, repo: null } }, 'fork-head'],
    ['a last parent that is not the live PR head',
      { head: { sha: 'e'.repeat(40), repo: { full_name: REPOSITORY } } }, 'candidate-last-parent-not-pr-head'],
  ] as const) {
    it(`rejects ${label}`, async () => {
      const repository = firstEntry();
      repository.pulls['6151'] = { ...sameRepoPull(PR_HEAD), ...pull };
      assert.equal(await rejection(repository), reason);
    });
  }

  it('fails closed when GitHub cannot answer', async () => {
    const verdict = await verifyMergeGroupCandidate(mergeGroup(), 'https://api.github.com',
      async () => response(502, undefined));
    assert.equal(verdict.kind === 'rejected' && verdict.reason, 'candidate-unreadable');
  });
});

describe('re-verifying an already proven merge queue candidate', () => {
  const reverify = (read: GithubReader) => reverifyMergeGroupCandidate(mergeGroup(), 'https://api.github.com', read);

  it('answers unreadable, not rejected, when GitHub cannot be reached', async () => {
    const verdict = await reverify((url) => Promise.reject(
      new GithubTransportError(`Could not reach ${url}: connect ETIMEDOUT`)));
    assert.equal(verdict.kind, 'unreadable');
    assert.match(verdict.kind === 'unreadable' ? verdict.detail : '', /ETIMEDOUT/);
  });

  it('answers unreadable when GitHub returns a server error for the entry or the pull request', async () => {
    const entryDown = await reverify(async () => response(503, undefined));
    assert.equal(entryDown.kind, 'unreadable');
    assert.match(entryDown.kind === 'unreadable' ? entryDown.detail : '', /^candidate-unreadable: .*HTTP 503/);
    const healthy = reader(firstEntry());
    const pullDown = await reverify(async (url) => (url.includes('/pulls/') ? response(502, undefined) : healthy(url)));
    assert.equal(pullDown.kind, 'unreadable');
    assert.match(pullDown.kind === 'unreadable' ? pullDown.detail : '', /^pull-request-unreadable: .*HTTP 502/);
  });

  it('still rejects a candidate GitHub proves invalid', async () => {
    const repository = firstEntry();
    repository.commits[CANDIDATE] = merge('7', BASE, PR_HEAD);
    repository.pulls['7'] = sameRepoPull(PR_HEAD);
    const verdict = await reverify(reader(repository));
    assert.equal(verdict.kind === 'rejected' && verdict.reason, 'candidate-top-entry-not-queued-pr');
    const draft = firstEntry();
    draft.pulls['6151'] = { ...sameRepoPull(PR_HEAD), draft: true };
    const drafted = await reverify(reader(draft));
    assert.equal(drafted.kind === 'rejected' && drafted.reason, 'pull-request-draft');
  });

  it('verifies a valid candidate and lets a defect propagate', async () => {
    assert.equal((await reverify(reader(firstEntry()))).kind, 'verified');
    await assert.rejects(reverify(() => Promise.reject(new TypeError('reader bug'))), /reader bug/);
  });
});

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, {
    cwd, encoding: 'utf8',
    env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@example.com',
      GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@example.com' },
  }).trim();
}

describe('merge queue candidate inventory', () => {
  it('diffs a cumulative candidate against the queue base, and refuses a moved queue ref', async () => {
    const root = mkdtempSync(join(tmpdir(), 'merge-group-inventory-'));
    const server = join(root, 'server');
    const remote = join(server, 'owner', 'repo.git');
    const work = join(root, 'work');
    mkdirSync(join(server, 'owner'), { recursive: true });
    git(root, 'init', '--bare', '--quiet', '-b', 'develop', remote);
    git(remote, 'config', 'uploadpack.allowAnySHA1InWant', 'true');
    git(remote, 'config', 'uploadpack.allowFilter', 'true');
    git(root, 'init', '--quiet', '-b', 'develop', work);
    writeFileSync(join(work, 'base.txt'), 'base\n');
    writeFileSync(join(work, 'old.txt'), 'renamed later\n');
    git(work, 'add', '.');
    git(work, 'commit', '--quiet', '-m', 'base');
    const base = git(work, 'rev-parse', 'HEAD');
    git(work, 'checkout', '--quiet', '-b', 'first');
    writeFileSync(join(work, 'first.txt'), 'first\n');
    git(work, 'add', '.');
    git(work, 'commit', '--quiet', '-m', 'first');
    git(work, 'checkout', '--quiet', 'develop');
    git(work, 'checkout', '--quiet', '-b', 'second');
    git(work, 'mv', 'old.txt', 'new.txt');
    git(work, 'commit', '--quiet', '-m', 'second');
    git(work, 'checkout', '--quiet', 'develop');
    git(work, 'merge', '--quiet', '--no-ff', '-m', 'first candidate', 'first');
    const firstCandidate = git(work, 'rev-parse', 'HEAD');
    git(work, 'merge', '--quiet', '--no-ff', '-m', 'second candidate', 'second');
    const secondCandidate = git(work, 'rev-parse', 'HEAD');
    assert.equal(git(work, 'rev-parse', 'HEAD^1'), firstCandidate);
    const queueRef = `refs/heads/gh-readonly-queue/develop/pr-2-${base}`;
    git(work, 'push', '--quiet', remote, `${base}:refs/heads/develop`, `${secondCandidate}:${queueRef}`);

    const revision = {
      repository: 'owner/repo', serverUrl: pathToFileURL(server).href.replace(/\/$/, ''),
      baseSha: base, candidateSha: secondCandidate, queueRef, token: 'test-token', temporaryRoot: root,
    };
    const inventory = await readMergeGroupInventory(revision);
    assert.deepEqual([...inventory.changed].sort(), ['first.txt', 'new.txt']);
    assert.deepEqual(inventory.deleted, ['old.txt']);

    await assert.rejects(readMergeGroupInventory({ ...revision, candidateSha: firstCandidate }),
      /no longer points at candidate/);

    // GitHub deletes an invalidated candidate's branch; a late run reads that
    // as the typed "candidate gone" outcome rather than a generic git failure.
    git(work, 'push', '--quiet', remote, `:${queueRef}`);
    await assert.rejects(readMergeGroupInventory(revision), (error: unknown) =>
      error instanceof MergeQueueCandidateGone && error.queueRef === queueRef);
  });
});

describe('merge_group aggregate and guard decisions', () => {
  it('keeps a live queue candidate current and skips a stale one', () => {
    assert.equal(queueRefDecision(QUEUE_REF, CANDIDATE, CANDIDATE).current, 'true');
    const moved = queueRefDecision(QUEUE_REF, CANDIDATE, PR_HEAD);
    assert.equal(moved.current, 'false');
    assert.equal(moved.exitCode, 0);
    assert.match(moved.messages.map(renderStepMessage).join('\n'), /stale merge queue candidate/);
    assert.equal(queueRefDecision(QUEUE_REF, CANDIDATE, undefined).current, 'false');
  });

  it('plans a queue candidate from its changed files, not as a manual full run', () => {
    const context = { forcedIosLanesRaw: '[]', reuseNativeEvidenceRaw: 'false', changedFilesDelimiter: 'X' };
    const manual = { eventName: 'workflow_dispatch', baseUpdateSuperseded: 'false', baseUpdateDeferred: 'false' };
    assert.notEqual(detectEarlyExitOutputs(context, manual), undefined);
    assert.equal(detectEarlyExitOutputs(context, { ...manual, eventName: 'merge_group' }), undefined);
  });

  const native = (overrides: Partial<NativeTestLaneStatusInput>) => deriveNativeTestLaneStatus({
    eventName: 'merge_group', testScope: '', dispatchRef: QUEUE_REF, repository: REPOSITORY,
    headRepository: REPOSITORY, baseBranch: 'develop', baseUpdateDeferred: 'false',
    changeGateResult: 'success', changeGateShouldRun: 'false', macRunnerResolutionResult: 'skipped',
    nativePreparationResult: 'skipped', nativeBuildResult: 'skipped', nativeExecutionRequired: 'false',
    releaseArchiveRequired: 'false', releaseArchiveResult: 'skipped', mainExecutionResult: 'skipped',
    mainRequired: 'false', evidenceRequired: 'false', ...overrides,
  });

  it('passes Test - iOS for an unselected queue candidate with a machine-readable reason', () => {
    const decision = native({});
    assert.equal(decision.exitCode, 0);
    assert.match(decision.messages.map(renderStepMessage).join('\n'), /^not selected: /);
  });

  it('requires a selected native lane and the Release archive to execute on a queue candidate', () => {
    const skipped = native({
      changeGateShouldRun: 'true', mainRequired: 'true', macRunnerResolutionResult: 'success',
    });
    assert.equal(skipped.exitCode, 1);
    assert.match(decisionErrors(skipped).join('\n'), /did not execute successfully: skipped/);
    const archive = native({
      changeGateShouldRun: 'true', mainRequired: 'true', macRunnerResolutionResult: 'success',
      mainExecutionResult: 'success', releaseArchiveRequired: 'true', releaseArchiveResult: 'skipped',
    });
    assert.equal(archive.exitCode, 1);
    assert.match(decisionErrors(archive).join('\n'), /Release archive did not pass/);
    assert.equal(native({
      changeGateShouldRun: 'true', mainRequired: 'true', macRunnerResolutionResult: 'success',
      mainExecutionResult: 'success',
    }).exitCode, 0);
  });

  const realServer = (overrides: Partial<RealServerE2eStatusInput>) => deriveRealServerE2eStatus({
    aggregate: 'onboarding-e2e-status', eventName: 'merge_group', testScope: '', dispatchRef: QUEUE_REF,
    changeGateResult: 'success', headRepository: REPOSITORY, repository: REPOSITORY, baseBranch: 'develop',
    budgetE2eEnabled: false,
    onboarding: { required: false, result: 'skipped' }, chatPlaid: { required: false, result: 'skipped' },
    income: { required: false, result: 'skipped' }, budget: { required: false, result: 'skipped' },
    schemaPreparationResult: 'skipped', ...overrides,
  });

  it('fails closed with a typed reason when development-e2e does not admit the queue ref', () => {
    const blocked = realServer({
      onboarding: { required: true, result: 'skipped' }, schemaPreparationResult: 'failure',
    });
    assert.equal(blocked.exitCode, 1);
    assert.match(decisionErrors(blocked).join('\n'),
      /^development-e2e-not-admitted: .*prepare-dev-e2e-schema ended failure.*gh-readonly-queue\/develop\/\*/);
  });

  it('judges queue candidate real-server lanes like a pull request once the environment admits them', () => {
    assert.equal(realServer({}).exitCode, 0);
    assert.match(realServer({}).messages.map(renderStepMessage).join('\n'), /^not selected: /);
    const failed = realServer({
      onboarding: { required: true, result: 'failure' }, schemaPreparationResult: 'success',
    });
    assert.equal(failed.exitCode, 1);
    assert.match(decisionErrors(failed).join('\n'), /Selected onboarding E2E did not pass: failure/);
    assert.equal(realServer({
      onboarding: { required: true, result: 'success' }, schemaPreparationResult: 'success',
    }).exitCode, 0);
  });
});

describe('PR Checks lane reasons', () => {
  it('states for every lane whether it executed or why it was not selected', () => {
    const input: PrValidationVerdictInput = {
      results: {
        'plan-pr-validation': 'success', lint: 'success', 'validation-policy': 'skipped',
        'workflow-contracts': 'success', 'server-static': 'skipped', 'server-process-tests': 'skipped',
        'server-tests': 'skipped', 'targeted-server-tests': 'success', 'ios-contracts': 'skipped',
        'database-integration': 'skipped',
      },
      docsOnly: 'false', lintPlan: { mode: 'full', paths: [] }, metadataOnly: 'false',
      policyRequired: 'false', workflowContractsRequired: 'true', serverStaticRequired: 'false',
      serverTestMode: 'targeted', processHeavyRequired: 'false', iosContractsRequired: 'false',
      databaseRequired: 'false',
    };
    assert.deepEqual(prValidationLaneReasons(input), [
      'lint: executed (success)',
      'validation-policy: not selected: policy_required=false',
      'workflow-contracts: executed (success)',
      'server-static: not selected: server_static_required=false',
      'server-process-tests: not selected: process_heavy_required=false',
      'server-tests: not selected: server_test_mode=targeted',
      'targeted-server-tests: executed (success)',
      'ios-contracts: not selected: ios_contracts_required=false',
      'database-integration: not selected: database_required=false',
    ]);
    assert.deepEqual(prValidationLaneReasons({ ...input, docsOnly: 'true' })[0], 'lint: not selected: docs-only change');
  });
});
