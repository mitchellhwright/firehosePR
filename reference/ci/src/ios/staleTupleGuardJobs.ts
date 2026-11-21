import { nameRegExp, workflowNames } from '../../../scripts/ci/generated/workflow-names.ts';

/**
 * The `Test - iOS` jobs that re-prove the live pull-request tuple before they
 * start Xcode (the shared typed `macRevisionAdmission.ts`, run by
 * `ci/src/actions/ios/verifyExactIosRevision.ts` or
 * `ci/src/actions/ios/verifyExactReleaseArchiveRevision.ts`). Once a newer
 * head replaces the run's, one of these jobs that has not started can only
 * fail that guard. Every other job — the gate, verdicts, aggregation — runs
 * without it, so a queued one still completes the run's evidence.
 *
 * `ci/tests/staleTupleGuardJobs.test.ts` derives this set from the rendered
 * workflow, so adding or removing the guard from a job fails there.
 */
export const STALE_TUPLE_GUARD_JOB_IDS = [
  'verify-ios-release-archive',
  'build-ios-native-test-products',
  'test-ios-execution',
  'build-ios-e2e-test-products',
  'onboarding-e2e',
  'chat-plaid-e2e',
  'income-e2e',
  'budget-e2e',
] as const satisfies readonly (keyof typeof workflowNames['ios-tests']['jobs'])[];

const guardJobNames = STALE_TUPLE_GUARD_JOB_IDS
  .map(id => nameRegExp(workflowNames['ios-tests'].jobs[id]));

/** Whether a `Test - iOS` job, by its rendered name, runs the stale-tuple guard. */
export function runsStaleTupleGuard(jobName: string | undefined): boolean {
  return typeof jobName === 'string' && guardJobNames.some(pattern => pattern.test(jobName));
}
