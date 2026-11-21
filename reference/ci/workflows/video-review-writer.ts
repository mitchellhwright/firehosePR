import {
  concat, expr, github, runner, trustedControlLinuxRunner, typedJob, typedStep, typedWorkflow, vars,
} from './lib/index.ts';
import { trustedProductionOnboardingE2e } from './trusted-production-onboarding-e2e.ts';

/**
 * The trusted production onboarding E2E records what its video review found
 * but does not file anything. This writer consumes that saved evidence and
 * files the advisory issues, behind two repository variables so filing can be
 * turned off without touching a workflow, and only from main.
 */
export const videoReviewWriter = typedWorkflow({
  path: '.github/workflows/video-review-writer.yml',
  source: 'ci/workflows/video-review-writer.ts',
  name: 'Advisory video issue writer',
  doc: { purpose: 'Files the advisory issues the production onboarding video review recorded.' },
  on: {
    // A workflow_run trigger names its producer by string, so this takes the
    // producer's name by value: renaming it there renames it here, instead of
    // leaving this workflow subscribed to a name nothing publishes any more.
    workflow_run: {
      workflows: [trustedProductionOnboardingE2e.config.name],
      types: ['completed'],
    },
    workflow_dispatch: {
      inputs: {
        producer_run_id: {
          description: 'Saved trusted production workflow run ID',
          required: true,
          type: 'string',
        },
        producer_run_attempt: {
          description: 'Saved producer attempt number',
          required: true,
          type: 'string',
        },
        apply: {
          description: 'Apply writes only after the rollout controls are verified',
          default: false,
          type: 'boolean',
        },
      },
    },
  },
  permissions: {},
  // One queue across automatic intake and manual replay. Overflow remains in
  // the producer artifact and must be replayed; never cancel an active writer.
  concurrency: { group: 'example-advisory-video-issue-writer', cancelInProgress: false },
  jobs: [
    typedJob('consume', {
      name: 'Publish advisory video review findings',
      doc: {
        purpose: 'Turns the producer run saved evidence into advisory issues.',
        successMeaning: 'Every finding in the saved evidence has an issue, or filing is switched off.',
      },
      owner: 'review',
      category: 'evidence',
      unit: 'job',
      if: expr(
        "(github.event_name == 'workflow_dispatch' && github.ref == 'refs/heads/main') "
        + "|| (github.event_name == 'workflow_run' "
        + '&& github.event.workflow_run.head_repository.full_name == github.repository '
        + "&& github.event.workflow_run.head_branch == 'main' "
        + "&& vars.ONBOARDING_VIDEO_ISSUE_FILING_ENABLED == '1' "
        + "&& vars.VIDEO_NAVARCH_CONTROLS_VERIFIED == '1')",
      ),
      // Pagination and recovery can exceed the slim image's fixed job limit.
      runsOn: trustedControlLinuxRunner,
      permissions: { contents: 'read', actions: 'read', issues: 'write' },
      lane: {
        runnerClass: 'hosted-control',
        costClass: 'control',
        evidencePolicy: 'exact-head',
        selectionOwner: 'controller',
      },
      steps: [
        typedStep({
          name: 'Checkout trusted writer implementation',
          doc: {
            purpose: 'Runs the writer from main, never from the producer run head.',
            recovery: 'retry; a repeated failure is a GitHub or runner network problem',
          },
          owner: 'infrastructure',
          category: 'environment',
          unit: 'step',
          uses: 'actions/checkout@v7.0.1',
          with: { ref: 'refs/heads/main', 'persist-credentials': false, 'fetch-depth': 1 },
        }),
        typedStep({
          name: 'Set up Node',
          doc: {
            purpose: 'Installs the Node.js version the writer script runs on.',
            recovery: 'retry; a repeated failure means the runner cannot reach the Node.js download',
          },
          owner: 'infrastructure',
          category: 'environment',
          unit: 'step',
          uses: 'actions/setup-node@v7.0.0',
          with: { 'node-version': '26.5.0' },
        }),
        typedStep({
          name: 'Consume saved producer evidence',
          doc: {
            purpose: 'Reads the producer run saved findings and files the advisory issues.',
            recovery: 'read the outcome artifact; unfiled findings stay in the producer artifact and can be replayed',
          },
          owner: 'automation',
          category: 'coordination',
          unit: 'step',
          command: 'node ci/src/actions/consumeVideoReview.ts',
          summaryTitle: 'Advisory video issue writer',
          env: {
            GITHUB_TOKEN: github('token'),
            VIDEO_PRODUCER_RUN_ID: expr(
              "github.event_name == 'workflow_run' && github.event.workflow_run.id || inputs.producer_run_id",
            ),
            VIDEO_PRODUCER_RUN_ATTEMPT: expr(
              "github.event_name == 'workflow_run' && github.event.workflow_run.run_attempt || inputs.producer_run_attempt",
            ),
            VIDEO_WRITER_APPLY: expr("(github.event_name == 'workflow_run' || inputs.apply) && '1' || '0'"),
            ONBOARDING_VIDEO_ISSUE_FILING_ENABLED: vars('ONBOARDING_VIDEO_ISSUE_FILING_ENABLED'),
            VIDEO_NAVARCH_CONTROLS_VERIFIED: vars('VIDEO_NAVARCH_CONTROLS_VERIFIED'),
            VIDEO_WRITER_OUTPUT: concat(runner('temp'), '/video-writer/outcome.json'),
          },
        }),
        typedStep({
          name: 'Preserve saved input and write outcomes',
          doc: {
            purpose: 'Keeps what the writer decided, including anything it could not file.',
            recovery: 'the writer produced no outcome file; read its step log for why',
          },
          owner: 'automation',
          category: 'evidence',
          unit: 'artifact',
          if: expr('always()'),
          uses: 'actions/upload-artifact@v7.0.1',
          with: {
            name: concat('video-writer-outcome-', github('run_id'), '-', github('run_attempt')),
            path: concat(runner('temp'), '/video-writer/outcome.json'),
            'if-no-files-found': 'warn',
            'retention-days': 14,
          },
        }),
      ],
    }),
  ],
});
