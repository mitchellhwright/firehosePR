import type { RunsOn } from 'gagen';
import {
  hostedLinuxRunnerLabels,
  sharedPortableLinuxRunnerLabels,
  trustedControlLinuxRunnerLabels,
} from '../../src/runnerPolicy.ts';
import { expr, type ExpressionValue } from './expressions.ts';
import { ciEventCondition } from './ciEvent.ts';

/** GitHub-hosted Linux is reserved for untrusted fork revisions and admitted overflow. */
export const hostedLinuxRunner = hostedLinuxRunnerLabels satisfies RunsOn;

/**
 * The trusted external control fleet is the default and unknown-capacity fallback.
 *
 * This is deliberately code, not a repository variable: a mutable variable
 * previously redirected every lightweight controller to hosted Linux and
 * made review and iOS planning depend on the billing state.
 */
export const trustedControlLinuxRunner = trustedControlLinuxRunnerLabels satisfies RunsOn;

/** Read-only verdicts can use the shared portable Linux fleet. */
export const portableVerdictLinuxRunner = sharedPortableLinuxRunnerLabels satisfies RunsOn;

/**
 * Code under review uses trusted Linux only when it belongs to this
 * repository: a same-repository pull request, a develop queue candidate (whose
 * PR origin the first job re-proves before any lane runs), or a dispatch.
 * Fork pull requests stay on isolated GitHub-hosted Linux.
 */
function reviewedRouteText(trusted: RunsOn): string {
  return `${ciEventCondition('sameRepositoryCode')} `
    + `&& '${JSON.stringify(trusted)}' `
    + `|| '${JSON.stringify(hostedLinuxRunner)}'`;
}

function reviewedRoute(trusted: RunsOn): ExpressionValue {
  return expr(`fromJson(${reviewedRouteText(trusted)})`);
}

/**
 * A downstream control or verdict job's route: the labels its run's first job
 * planned (`ci/src/actions/selectControlRunners.ts` — the external fleet unless
 * it has a backlog, then admitted hosted overflow), or the static reviewed
 * route when that output is absent (a skipped planner step or an older base).
 */
function plannedReviewedRoute(plannedLabels: string, trusted: RunsOn): ExpressionValue {
  return expr(`fromJson(${plannedLabels} || (${reviewedRouteText(trusted)}))`);
}

/** Control work after the first job: planned external-or-overflow route. */
export function plannedControlLinuxRunner(plannedLabels: string): ExpressionValue {
  return plannedReviewedRoute(plannedLabels, trustedControlLinuxRunner);
}

/** Read-only required verdicts: shared portable Linux for reviewed code. */
export const reviewedEventPortableVerdictLinuxRunner: ExpressionValue =
  reviewedRoute(portableVerdictLinuxRunner);

/** Planning and control work: the dedicated external control fleet for reviewed code. */
export const reviewedEventControlLinuxRunner: ExpressionValue = reviewedRoute(trustedControlLinuxRunner);

/**
 * The first control route can probe hosted capacity only while overflow policy
 * is enabled. The emergency policy switch keeps it on trusted external Linux.
 */
export function initialControlAdmissionRunner(sameRepository: string): ExpressionValue {
  return expr(`fromJson(${sameRepository} `
    + `&& vars.CI_HOSTED_LINUX_AVAILABLE != '1' `
    + `&& '${JSON.stringify(trustedControlLinuxRunner)}' `
    + `|| '${JSON.stringify(hostedLinuxRunner)}')`);
}

export const initialControlAdmissionLinuxRunner: ExpressionValue =
  initialControlAdmissionRunner(ciEventCondition('sameRepositoryCode'));

/** Controllers execute only default-branch code; unreadable admission stays external. */
export function plannedTrustedControlLinuxRunner(plannedLabels: string): ExpressionValue {
  return expr(`fromJson(${plannedLabels} || '${JSON.stringify(trustedControlLinuxRunner)}')`);
}
