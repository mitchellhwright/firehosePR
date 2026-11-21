import { basename } from 'node:path';
import {
  concat, deployedSha, expr, github, PRODUCTION_DEPLOYED_DISPATCH_TYPE,
  productionDeployConcurrencyKey, productionDeployReported, trustedControlLinuxRunner, typedJob,
  typedStep, typedWorkflow,
} from './lib/index.ts';
import { trustedProductionOnboardingE2e } from './trusted-production-onboarding-e2e.ts';

/**
 * Turns a production deploy report into a production onboarding E2E run for
 * that exact main commit.
 *
 * Cloud Build reports the production (example-production) deploy as a check run on
 * the deployed commit; a deploy pipeline may instead send a
 * `production-deployed` repository dispatch. Both events run this default
 * branch definition with the default branch as their ref, and the
 * production-e2e environment admits only main, so the E2E cannot run from
 * the report itself. This workflow checks the report once and dispatches the
 * E2E on main with the reported SHA; that workflow then proves the SHA is
 * main's head and is serving before it allocates the macOS runner.
 *
 * GitHub does not send check_run events for check suites GitHub Actions
 * created, so this only wakes for other apps' check runs, and the job `if`
 * skips every one that is not the production deploy succeeding.
 */
export const productionDeployDispatch = typedWorkflow({
  path: '.github/workflows/production-deploy-dispatch.yml',
  source: 'ci/workflows/production-deploy-dispatch.ts',
  name: 'Production deploy dispatch',
  doc: { purpose: 'Starts the production onboarding E2E for each main commit production reports deployed.' },
  on: {
    check_run: { types: ['completed'] },
    repository_dispatch: { types: [PRODUCTION_DEPLOYED_DISPATCH_TYPE] },
  },
  permissions: { contents: 'read' },
  // Reports of the same commit queue behind each other, so the second one
  // sees the run the first dispatched; unrelated check runs never share a key.
  concurrency: {
    group: concat('production-deploy-dispatch-', productionDeployConcurrencyKey),
    cancelInProgress: false,
  },
  jobs: [
    typedJob('dispatch-production-e2e', {
      name: 'Dispatch production onboarding E2E',
      doc: {
        purpose: 'Dispatches the production onboarding E2E on main for the commit production just deployed.',
        successMeaning: 'The E2E was dispatched, or was not needed because main moved on or a run is active.',
      },
      owner: 'automation',
      category: 'coordination',
      unit: 'job',
      if: expr(productionDeployReported),
      runsOn: trustedControlLinuxRunner,
      timeoutMinutes: 5,
      permissions: { actions: 'write', contents: 'read' },
      lane: {
        runnerClass: 'hosted-control',
        costClass: 'control',
        evidencePolicy: 'none',
        selectionOwner: 'controller',
      },
      steps: [
        // The default-branch checkout: reviewed dispatcher code, never the
        // deployed commit. No partial-clone filter on the shared control
        // runner workspace; see ci/src/persistentWorkspace.ts.
        typedStep({
          name: 'Check out the typed dispatcher',
          doc: {
            purpose: 'Puts the typed dispatcher this job runs in the workspace; without it it is absent or stale.',
            recovery: 'retry; a repeated failure is a GitHub or runner network problem',
          },
          owner: 'infrastructure',
          category: 'environment',
          unit: 'step',
          uses: 'actions/checkout@v7.0.1',
          with: { 'fetch-depth': 1, 'persist-credentials': false },
        }),
        typedStep({
          name: 'Dispatch exact main verification',
          doc: {
            purpose: 'Dispatches the E2E on main for the deployed SHA when it is still main\'s head.',
            recovery: 'read the gh api error; a 403 means the job token lost actions: write',
          },
          owner: 'automation',
          category: 'coordination',
          unit: 'step',
          summaryTitle: 'Production onboarding E2E dispatch',
          command: 'node ci/src/actions/dispatchProductionE2e.ts',
          env: {
            DEPLOYED_SHA: deployedSha,
            GH_TOKEN: github('token'),
            PRODUCTION_E2E_WORKFLOW: basename(trustedProductionOnboardingE2e.config.path),
          },
        }),
      ],
    }),
  ],
});
