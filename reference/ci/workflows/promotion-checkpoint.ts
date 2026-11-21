import {
  expr, github, secret, trustedControlLinuxRunner, typedJob, typedStep, typedWorkflow,
} from './lib/index.ts';

/**
 * A promotion pull request from `develop` to `main` is mutable: every later
 * push to `develop` moves its head, which resets the exact-head evidence the
 * main ruleset needs. This workflow freezes the head it was told about on a
 * `promotion/develop-<sha>` branch, opens a draft replacement against `main`,
 * proves that at most one deterministic iOS marketing-version commit and
 * GitHub's own Update Branch merges are the only commits added on top,
 * and only then closes the mutable source.
 *
 * Every mutation is compensated: a failure after the replacement exists
 * returns it to draft, and a failure after the source closed reopens it, so a
 * half-applied transaction cannot leave the promotion without a pull request.
 */

const appToken = typedStep({
  id: 'app-token',
  name: 'Create promotion GitHub App token',
  doc: {
    purpose: 'Mints the scoped token the transaction uses to create the branch and move both pull requests.',
    recovery: 'check the App installation still covers this repository and grants contents and pull-requests write',
  },
  owner: 'automation',
  category: 'release',
  unit: 'step',
  uses: 'actions/create-github-app-token@v3.2.0',
  with: {
    'app-id': secret('PROMOTION_CHECKPOINT_APP_ID'),
    'private-key': secret('PROMOTION_CHECKPOINT_APP_PRIVATE_KEY'),
    owner: github('repository_owner'),
    repositories: github('event.repository.name'),
  },
});

const checkpoint = typedStep({
  id: 'checkpoint',
  name: 'Create immutable checkpoint pull request',
  doc: {
    purpose: 'Selects the next approved iOS patch from Apple, freezes develop at this head, proves current main, then closes the mutable source.',
    recovery: 'read the error: it names the tuple that moved, and a newer event retries from its exact state',
  },
  owner: 'automation',
  category: 'coordination',
  unit: 'step',
  summaryTitle: 'Promotion checkpoint transaction',
  outputs: [
    'checkpoint_branch', 'checkpoint_pr_number', 'checkpoint_url', 'checkpoint_head', 'checkpoint_base',
  ] as const,
  command: 'node ci/src/actions/createPromotionCheckpoint.ts',
  env: {
    GITHUB_API_URL: github('api_url'),
    GH_TOKEN: expr('steps.app-token.outputs.token'),
    HEAD_SHA: github('event.pull_request.head.sha'),
    ORIGINAL_PR_NUMBER: github('event.pull_request.number'),
    REPOSITORY: github('repository'),
    REPOSITORY_OWNER: github('repository_owner'),
    APP_STORE_CONNECT_API_KEY_ID: secret('APP_STORE_CONNECT_API_KEY_ID'),
    APP_STORE_CONNECT_API_KEY_ISSUER_ID: secret('APP_STORE_CONNECT_API_KEY_ISSUER_ID'),
    APP_STORE_CONNECT_API_KEY_CONTENT: secret('APP_STORE_CONNECT_API_KEY_CONTENT'),
    APP_STORE_CONNECT_APP_ID: '1234567890',
  },
});

export const promotionCheckpoint = typedWorkflow({
  path: '.github/workflows/promotion-checkpoint.yml',
  source: 'ci/workflows/promotion-checkpoint.ts',
  name: 'Create promotion checkpoint',
  doc: { purpose: 'Replaces a mutable develop promotion with an immutable checkpoint pull request against main.' },
  on: {
    pull_request_target: {
      branches: ['main'],
      types: ['opened', 'reopened', 'synchronize', 'edited'],
    },
  },
  // The App token creates branches and moves pull requests; the job token
  // itself only reads, so a compromised step cannot mutate the promotion.
  permissions: { contents: 'read', 'pull-requests': 'read' },
  // Two overlapping runs would race on the same checkpoint branch and could
  // close the source twice, so promotions queue rather than cancel.
  concurrency: { group: 'promotion-checkpoint-main', cancelInProgress: false },
  jobs: [
    typedJob('checkpoint', {
      name: 'Freeze develop promotion checkpoint',
      doc: {
        purpose: 'Turns the mutable develop promotion into a frozen checkpoint pull request against main.',
        successMeaning: 'An open checkpoint pull request carries this develop head merged with a proven current main.',
      },
      owner: 'automation',
      category: 'release',
      unit: 'job',
      if: expr(
        "github.event.pull_request.head.ref == 'develop' "
        + "&& github.event.pull_request.base.ref == 'main' "
        + '&& github.event.pull_request.head.repo.full_name == github.repository',
      ),
      runsOn: trustedControlLinuxRunner,
      timeoutMinutes: 10,
      lane: {
        runnerClass: 'hosted-control',
        costClass: 'control',
        evidencePolicy: 'none',
        selectionOwner: 'controller',
      },
      steps: [
        // pull_request_target checks out the base branch, never the develop
        // head this run is about, so the transaction is the reviewed
        // copy on main rather than whatever the promotion proposes.
        typedStep({
          name: 'Check out the checkpoint transaction',
          doc: {
            purpose: 'Puts the transaction scripts this job runs in the workspace; without them nothing can start.',
            recovery: 'retry; a repeated failure is a GitHub or runner network problem',
          },
          owner: 'infrastructure',
          category: 'environment',
          unit: 'step',
          uses: 'actions/checkout@v7.0.1',
          with: { 'persist-credentials': false, 'fetch-depth': 1 },
        }),
        typedStep({
          name: 'Set up Node.js for the typed transaction',
          doc: {
            purpose: 'Provides the pinned Node runtime for the typed promotion transaction.',
            recovery: 'retry; a repeated failure is a GitHub or runner network problem',
          },
          owner: 'infrastructure',
          category: 'environment',
          unit: 'step',
          uses: 'actions/setup-node@v7.0.0',
          with: { 'node-version': '26.5.0' },
        }),
        typedStep({
          name: 'Install typed promotion transaction dependencies',
          doc: {
            purpose: 'Installs the pinned, standalone CI type and JSON parser dependencies from the trusted main checkout.',
            recovery: 'retry an npm registry failure; a repeated failure requires dependency investigation',
          },
          owner: 'infrastructure',
          category: 'environment',
          unit: 'step',
          command: 'npm ci --prefix ci --no-audit --no-fund --ignore-scripts',
        }),
        appToken,
        checkpoint,
        typedStep({
          name: 'Summarize promotion checkpoint',
          doc: {
            purpose: 'Records the checkpoint pull request, its branch and the proven head and base in the run summary.',
            recovery: 'read the step log; the checkpoint transaction itself already completed before this step ran',
          },
          owner: 'automation',
          category: 'evidence',
          unit: 'step',
          command: 'node ci/src/actions/summarizePromotionCheckpoint.ts',
          env: {
            CHECKPOINT_BRANCH: checkpoint.outputs.checkpoint_branch,
            CHECKPOINT_PR_NUMBER: checkpoint.outputs.checkpoint_pr_number,
            CHECKPOINT_URL: checkpoint.outputs.checkpoint_url,
            CHECKPOINT_HEAD: checkpoint.outputs.checkpoint_head,
            CHECKPOINT_BASE: checkpoint.outputs.checkpoint_base,
            HEAD_SHA: github('event.pull_request.head.sha'),
          },
        }),
      ],
    }),
  ],
});
