import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { load } from 'js-yaml';

/**
 * A job whose token can write must run trusted code only. On a same-repository
 * pull request the job token belongs to the workflow, but a program checked
 * out from the PR head is whatever the PR says it is: with `actions: write`
 * it could cancel or rerun unrelated work. So every checkout in a
 * write-scoped job must name a trusted revision explicitly, never the head
 * under review (and never the event's default, which is that head).
 */

const WORKFLOWS = [
  '.github/workflows/ios-tests.yml',
  '.github/workflows/pr-checks.yml',
  '.github/workflows/refresh-pr-ci-after-base-edit.yml',
] as const;

interface Step {
  readonly uses?: string;
  readonly with?: Readonly<Record<string, unknown>>;
}
interface Job {
  readonly permissions?: Readonly<Record<string, string>> | string;
  readonly steps?: readonly Step[];
}

/** Revisions the head under review cannot choose. */
const TRUSTED_REF = /event\.repository\.default_branch|^refs\/heads\/(?:main|develop)$|base_sha|base\.sha|trusted-gate-source\.outputs\.commit|verifier_sha|EXAMPLE_CI_TRUSTED_BASE_SHA/;
/** Anything naming the head under review, or the queue candidate built from it. */
const HEAD_REF = /head\.sha|head_sha|github\.sha|github\.ref\b|head_ref|checkpoint_sha/;

/**
 * `id-token: write` mints an OIDC token for cloud auth, not a GitHub write;
 * the real-server E2E jobs hold it with the head checked out by design, and
 * their cloud-side trust policy is what bounds it.
 */
function writeScopes(job: Job): string[] {
  if (job.permissions === 'write-all') return ['write-all'];
  if (typeof job.permissions !== 'object') return [];
  return Object.entries(job.permissions)
    .filter(([scope, level]) => level === 'write' && scope !== 'id-token')
    .map(([scope]) => scope);
}

/**
 * The typed trusted-base projection resolves a manual dispatch to the
 * dispatched commit, which someone with write access chose; that branch of
 * the expression is not the head of a pull request.
 */
const DISPATCHED_COMMIT = /\(github\.event_name == 'workflow_dispatch' && toJSON\(github\.sha\)\)/g;

/** Checkouts in a job that could materialise the head under review. */
function untrustedCheckouts(job: Job): string[] {
  return (job.steps ?? [])
    .filter((step) => step.uses?.startsWith('actions/checkout@') === true)
    .map((step) => String(step.with?.['ref'] ?? ''))
    .filter((ref) => {
      const pullRequestRef = ref.replace(DISPATCHED_COMMIT, '');
      return ref === '' || HEAD_REF.test(pullRequestRef) || !TRUSTED_REF.test(pullRequestRef);
    });
}

function writeScopedHeadJobs(document: { readonly jobs: Readonly<Record<string, Job>> }): string[] {
  return Object.entries(document.jobs).flatMap(([id, job]) => {
    const scopes = writeScopes(job);
    const untrusted = untrustedCheckouts(job);
    return scopes.length > 0 && untrusted.length > 0
      ? [`${id} holds ${scopes.join('+')} write and checks out ${untrusted.map((ref) => ref || '(event default)').join(', ')}`]
      : [];
  });
}

test('no job with a write-scoped token checks out the code under review', () => {
  for (const path of WORKFLOWS) {
    const document = load(readFileSync(new URL(`../../${path}`, import.meta.url), 'utf8')) as {
      readonly jobs: Readonly<Record<string, Job>>;
    };
    assert.deepEqual(writeScopedHeadJobs(document), [], path);
  }
});

test('a write-scoped job checking out the head, or the event default, is reported', () => {
  const job = (ref?: string): Job => ({
    permissions: { actions: 'write', contents: 'read' },
    steps: [{ uses: 'actions/checkout@sha', ...(ref === undefined ? {} : { with: { ref } }) }],
  });
  assert.equal(writeScopedHeadJobs({ jobs: { a: job() } }).length, 1);
  assert.equal(writeScopedHeadJobs({ jobs: { a: job('${{ github.event.pull_request.head.sha }}') } }).length, 1);
  assert.deepEqual(writeScopedHeadJobs({ jobs: { a: job('${{ github.event.repository.default_branch }}') } }), []);
  assert.deepEqual(writeScopedHeadJobs({ jobs: { a: { ...job(), permissions: { actions: 'read' } } } }), []);
});
