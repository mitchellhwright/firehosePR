import type { GitHubJsonReader, WorkflowJob } from '../../../scripts/ci/types/github.d.mts';

import { nameRegExp, workflowNames } from '../../../scripts/ci/generated/workflow-names.ts';

/**
 * Which attempt's gate wrote the selection record a re-plan compares with.
 *
 * "Re-run failed jobs" carries every successful job of the earlier attempt
 * forward. The carried copy is listed under the new attempt with a new job id
 * and the new `run_attempt`, but keeps the original execution's
 * `started_at`, `completed_at` and `runner_id` (run 36257936571: the gate is
 * job 108450209791 in attempt 1 and job 108492965199 in attempt 2, both
 * 17:21:10–17:21:53 on runner 112). The gate that ran uploaded
 * `ios-native-selection-record-<its attempt>`, so the record attempt is the
 * earliest attempt whose gate job is that same execution.
 */

const IOS_TESTS = workflowNames['ios-tests'];
const GATE_JOB = nameRegExp(IOS_TESTS.jobs['ios-change-gate']);
const EXECUTION_JOB = nameRegExp(IOS_TESTS.jobs['test-ios-execution']);
const REAL_SERVER_JOB = nameRegExp(IOS_TESTS.jobs['budget-e2e']);
const NATIVE_PRODUCTS_JOB = IOS_TESTS.jobs['build-ios-native-test-products'].name;
const STOREKIT_JOB = IOS_TESTS.jobs['storekit-purchase-status'].name;
const RELEASE_ARCHIVE_JOB = IOS_TESTS.jobs['verify-ios-release-archive'].name;

export interface ReplanRecordBinding {
  /** The attempt whose gate wrote the record; `null` when it cannot be proven. */
  readonly recordAttempt: number | null;
  readonly detail: string;
  /** Evidence jobs that succeeded in the successful attempt, as `kind:lane` keys. */
  readonly successfulJobs: readonly string[];
}

function isSucceeded(job: WorkflowJob): boolean {
  return job.status === 'completed' && job.conclusion === 'success';
}

/**
 * The evidence jobs a selection record can require, keyed the way
 * `requiredEvidenceJobs` in nativeSelectionRecord.ts names them.
 */
export function successfulEvidenceJobs(jobs: readonly WorkflowJob[]): string[] {
  const keys = new Set<string>();
  for (const job of jobs) {
    if (!isSucceeded(job)) continue;
    const name = job.name ?? '';
    const lane = EXECUTION_JOB.exec(name)?.groups?.['suffix'];
    if (lane !== undefined) keys.add(`native:${lane}`);
    const realServer = REAL_SERVER_JOB.exec(name)?.groups?.['suffix'];
    if (realServer !== undefined) keys.add(`e2e:${realServer.startsWith('budget') ? 'budget' : realServer}`);
    if (name === NATIVE_PRODUCTS_JOB) keys.add('native-products');
    if (name === STOREKIT_JOB) keys.add('storekit');
    if (name === RELEASE_ARCHIVE_JOB) keys.add('release-archive');
  }
  return [...keys].sort();
}

function completeListing(listing: { total_count?: number, jobs?: readonly WorkflowJob[] } | undefined): readonly WorkflowJob[] | null {
  const jobs = listing?.jobs;
  return Array.isArray(jobs) && listing?.total_count === jobs.length ? jobs : null;
}

function executedGate(jobs: readonly WorkflowJob[]): WorkflowJob | undefined {
  const gates = jobs.filter(job => GATE_JOB.test(job.name ?? ''));
  const gate = gates.length === 1 ? gates[0] : undefined;
  return gate !== undefined && isSucceeded(gate) && typeof gate.started_at === 'string'
    && typeof gate.completed_at === 'string' && typeof gate.runner_id === 'number'
    ? gate
    : undefined;
}

function sameExecution(left: WorkflowJob, right: WorkflowJob): boolean {
  return left.started_at === right.started_at && left.completed_at === right.completed_at
    && left.runner_id === right.runner_id;
}

export async function bindReplanRecord({ runId, runAttempt, headSha, request, token }: {
  readonly runId: number;
  readonly runAttempt: number;
  readonly headSha: string;
  readonly request: GitHubJsonReader;
  readonly token: string | undefined;
}): Promise<ReplanRecordBinding> {
  const latest = completeListing(
    await request(`actions/runs/${runId}/jobs?filter=latest&per_page=100`, token),
  );
  if (latest === null || latest.some(job => job.run_id !== runId
    || job.run_attempt !== runAttempt || job.head_sha !== headSha)) {
    return { recordAttempt: null, detail: 'latest-jobs-unproven', successfulJobs: [] };
  }
  const successfulJobs = successfulEvidenceJobs(latest);
  const gate = executedGate(latest);
  if (gate === undefined) return { recordAttempt: null, detail: 'gate-job-missing', successfulJobs };
  for (let attempt = 1; attempt < runAttempt; attempt += 1) {
    const earlier = completeListing(
      await request(`actions/runs/${runId}/attempts/${attempt}/jobs?per_page=100`, token),
    );
    if (earlier === null) {
      return { recordAttempt: null, detail: `attempt-${attempt}-jobs-incomplete`, successfulJobs };
    }
    const earlierGate = executedGate(earlier);
    if (earlierGate !== undefined && earlierGate.run_attempt === attempt
      && earlierGate.head_sha === headSha && sameExecution(earlierGate, gate)) {
      return { recordAttempt: attempt, detail: 'carried-forward-gate', successfulJobs };
    }
  }
  return { recordAttempt: runAttempt, detail: 'gate-ran-in-success-attempt', successfulJobs };
}
