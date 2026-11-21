import { expr, github, secret, trustedControlLinuxRunner, typedJob, typedStep, typedWorkflow } from './lib/index.ts';
import { maintenanceNode } from './lib/maintenanceNode.ts';

const appStoreConnectCredentials = {
  APP_STORE_CONNECT_API_KEY_ID: secret('APP_STORE_CONNECT_API_KEY_ID'),
  APP_STORE_CONNECT_API_KEY_ISSUER_ID: secret('APP_STORE_CONNECT_API_KEY_ISSUER_ID'),
  APP_STORE_CONNECT_API_KEY_CONTENT: secret('APP_STORE_CONNECT_API_KEY_CONTENT'),
};

type TagTokenInputs = {
  readonly 'app-id': ReturnType<typeof secret>;
  readonly 'private-key': ReturnType<typeof secret>;
  readonly 'permission-contents': 'write';
  readonly 'permission-workflows': 'write';
};

const tagTokenInputs = {
  'app-id': secret('PROMOTION_CHECKPOINT_APP_ID'),
  'private-key': secret('PROMOTION_CHECKPOINT_APP_PRIVATE_KEY'),
  'permission-contents': 'write',
  'permission-workflows': 'write',
} as const satisfies TagTokenInputs;

const appToken = typedStep({
  id: 'app-token',
  name: 'Create GitHub App token for Xcode Cloud tags',
  doc: {
    purpose: 'Mints the scoped App token with Contents and Workflows write for tags on workflow-changing commits.',
    recovery: 'check the App installation still covers this repository and grants Contents and Workflows write',
  },
  owner: 'automation',
  category: 'artifact',
  unit: 'step',
  uses: 'actions/create-github-app-token@v3.2.0',
  with: {
    ...tagTokenInputs,
    owner: github('repository_owner'),
    repositories: github('event.repository.name'),
  },
});

/**
 * Xcode Cloud builds main outside GitHub Actions, so nothing in this
 * repository records which commit produced a successful build. Hourly, and on
 * every push to main, this job asks App Store Connect and writes the answer
 * back as a git tag, which is what release evidence and the promotion
 * checkpoint read later.
 */
export const xcodeCloudBuildTags = typedWorkflow({
  path: '.github/workflows/xcode-cloud-build-tags.yml',
  source: 'ci/workflows/xcode-cloud-build-tags.ts',
  name: 'Track Xcode Cloud builds',
  doc: { purpose: 'Tags the commits whose Xcode Cloud builds succeeded on main.' },
  on: {
    push: { branches: ['main'] },
    schedule: [{ cron: '37 * * * *' }],
    workflow_dispatch: {},
  },
  permissions: { contents: 'read' },
  // Tags are shared state: two reconciliations at once would race to create
  // the same tag, so they queue instead of cancelling each other.
  concurrency: { group: 'xcode-cloud-build-tags', cancelInProgress: false },
  jobs: [
    typedJob('reconcile', {
      name: 'Tag successful Xcode Cloud main builds',
      doc: {
        purpose: 'Reconciles App Store Connect build records with the tags in this repository.',
        successMeaning: 'Every successful Xcode Cloud main build has a tag naming its commit.',
      },
      owner: 'product',
      category: 'artifact',
      unit: 'job',
      // A manual dispatch from a feature branch would tag from the wrong
      // history; scheduled and push runs are already on the default branch.
      if: expr(
        "github.event_name != 'workflow_dispatch' || github.ref == 'refs/heads/main' "
        + "|| github.ref == format('refs/heads/{0}', github.event.repository.default_branch)",
      ),
      runsOn: trustedControlLinuxRunner,
      lane: {
        runnerClass: 'linux-self-hosted',
        costClass: 'light',
        evidencePolicy: 'none',
        selectionOwner: 'controller',
      },
      steps: [
        typedStep({
          name: 'Checkout the workflow revision',
          doc: {
            purpose: 'Puts the reconciliation script on the runner at the default branch.',
            recovery: 'retry; a repeated failure is a GitHub or runner network problem',
          },
          owner: 'infrastructure',
          category: 'environment',
          unit: 'step',
          uses: 'actions/checkout@v7.0.1',
          with: { ref: github('event.repository.default_branch'), 'persist-credentials': false },
        }),
        maintenanceNode,
        typedStep({
          name: 'Validate App Store Connect configuration',
          doc: {
            purpose: 'Names every missing App Store Connect secret before the reconciliation starts.',
            recovery: 'set the named repository secrets; the reconciliation cannot authenticate without them',
          },
          owner: 'product',
          category: 'quality',
          unit: 'step',
          command: 'node ci/src/actions/validateAppStoreConnectConfiguration.ts',
          env: appStoreConnectCredentials,
        }),
        appToken,
        typedStep({
          name: 'Reconcile Xcode Cloud build tags',
          doc: {
            purpose: 'Creates a tag for each successful Xcode Cloud build that does not have one.',
            recovery: 'read the App Store Connect response in the log; a 401 means the key expired',
          },
          owner: 'product',
          category: 'artifact',
          unit: 'step',
          command: 'node ci/src/actions/reconcileXcodeCloudBuildTags.ts',
          env: {
            ...appStoreConnectCredentials,
            APP_STORE_CONNECT_APP_ID: '1234567890',
            GH_TOKEN: expr('steps.app-token.outputs.token'),
            REPOSITORY: github('repository'),
          },
        }),
      ],
    }),
  ],
});
