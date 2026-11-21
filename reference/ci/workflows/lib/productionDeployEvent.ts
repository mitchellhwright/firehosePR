import { expr, type ExpressionValue } from 'gagen';
import { selectEventValue, whenEventHolds } from './ciEvent.ts';

/**
 * The events that report "production now serves this main commit", and the
 * one place a workflow reads the reported commit from their payloads.
 *
 * Both events run the default branch's workflow definition with
 * `github.sha`/`github.ref` set to the default branch, so neither can carry
 * the exact main revision in those fields; the deployed commit comes from the
 * payload, projected here per event in the same shape as `ciEvent.ts`.
 */
export const PRODUCTION_DEPLOY_EVENTS = ['check_run', 'repository_dispatch'] as const;
export type ProductionDeployEvent = typeof PRODUCTION_DEPLOY_EVENTS[number];

type PerProductionDeployEvent<T> = { readonly [E in ProductionDeployEvent]: T };

/**
 * The check run Google Cloud Build reports on a main commit when the
 * production (example-production) trigger finishes, as read from the live check runs
 * of main commit 58f245ad984c517ce0f00be6fafe6e635226608a. GitHub sets the
 * app of a check run from the credential that created it, so the app id and
 * slug cannot be claimed by another integration; the name picks the
 * production trigger out of Cloud Build's other triggers.
 */
export const PRODUCTION_DEPLOY_CHECK_RUN = {
  appId: 10529,
  appSlug: 'google-cloud-build',
  name: 'example-production-site-trigger (example-production)',
  conclusion: 'success',
  headBranch: 'main',
} as const;

/** The `repository_dispatch` type a deploy pipeline may send instead of the check run. */
export const PRODUCTION_DEPLOYED_DISPATCH_TYPE = 'production-deployed';

const CHECK_RUN = 'github.event.check_run';

const PRODUCTION_DEPLOY_CHECK_RUN_CONDITION = [
  `${CHECK_RUN}.app.id == ${PRODUCTION_DEPLOY_CHECK_RUN.appId}`,
  `${CHECK_RUN}.app.slug == '${PRODUCTION_DEPLOY_CHECK_RUN.appSlug}'`,
  `${CHECK_RUN}.name == '${PRODUCTION_DEPLOY_CHECK_RUN.name}'`,
  `${CHECK_RUN}.conclusion == '${PRODUCTION_DEPLOY_CHECK_RUN.conclusion}'`,
  `${CHECK_RUN}.check_suite.head_branch == '${PRODUCTION_DEPLOY_CHECK_RUN.headBranch}'`,
].join(' && ');

const deployReported: PerProductionDeployEvent<string> = {
  check_run: `(${PRODUCTION_DEPLOY_CHECK_RUN_CONDITION})`,
  repository_dispatch: `github.event.action == '${PRODUCTION_DEPLOYED_DISPATCH_TYPE}'`,
};

const deployedShaSource: PerProductionDeployEvent<string> = {
  check_run: `${CHECK_RUN}.head_sha`,
  repository_dispatch: "github.event.client_payload.sha || ''",
};

/** True only for a successful production deploy report; every other check run is ignored. */
export const productionDeployReported: string =
  whenEventHolds(PRODUCTION_DEPLOY_EVENTS, deployReported);

/** The main commit the deploy reported. Runtime still proves it is main's head. */
export const deployedSha: ExpressionValue =
  expr(selectEventValue(PRODUCTION_DEPLOY_EVENTS, deployedShaSource));

const perRun = "format('run-{0}', github.run_id)";
const perCommit = (sha: string): string => `format('sha-{0}', ${sha})`;

/**
 * One concurrency key per reported commit, so duplicate reports of the same
 * deploy queue behind each other; every unrelated check run gets its own key
 * and can never displace a pending report.
 */
export const productionDeployConcurrencyKey: ExpressionValue = expr(selectEventValue(
  PRODUCTION_DEPLOY_EVENTS,
  {
    check_run: `${deployReported.check_run} && ${perCommit(deployedShaSource.check_run)} || ${perRun}`,
    repository_dispatch: perCommit(deployedShaSource.repository_dispatch),
  },
  perRun,
));
