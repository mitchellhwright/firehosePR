import {
  concat, expr, github, secret, trustedControlLinuxRunner, typedJob, typedStep, typedWorkflow,
} from './lib/index.ts';

/** GitHub has no repository-wide switch to arm auto-merge for each new PR. */
export const enableInternalPrAutoMerge = typedWorkflow({
  path: '.github/workflows/enable-internal-pr-auto-merge.yml',
  source: 'ci/workflows/enable-internal-pr-auto-merge.ts',
  name: 'Enable native PR auto-merge',
  doc: { purpose: 'Arms GitHub auto-merge for current same-repository develop PRs without replacing native protections.' },
  on: { pull_request_target: { types: ['opened', 'reopened', 'ready_for_review', 'synchronize', 'edited'] } },
  permissions: { contents: 'read', 'pull-requests': 'read' },
  concurrency: { group: concat('native-auto-merge-', github('event.pull_request.number')), cancelInProgress: false },
  jobs: [typedJob('enable-auto-merge', {
    name: 'Arm native auto-merge',
    doc: {
      purpose: 'Records merge intent for a current internal PR; GitHub enforces reviews and required checks.',
      successMeaning: 'Auto-merge is armed, already armed, or this event is ineligible.',
    },
    owner: 'automation',
    category: 'coordination',
    unit: 'job',
    if: expr("github.event.pull_request.draft == false && github.event.pull_request.base.ref == 'develop' "
      + "&& github.event.pull_request.head.repo.full_name == github.repository "
      + "&& github.event.pull_request.user.type == 'User' "
      + "&& (github.event.action != 'edited' || github.event.changes.base != null)"),
    runsOn: trustedControlLinuxRunner,
    timeoutMinutes: 5,
    permissions: { contents: 'read', 'pull-requests': 'read' },
    lane: {
      runnerClass: 'hosted-control', costClass: 'control', evidencePolicy: 'none', selectionOwner: 'controller',
    },
    steps: [
      typedStep({
        name: 'Check out trusted default-branch enabler',
        doc: { purpose: 'Runs only reviewed default-branch code, never PR head code.', recovery: 'retry a checkout failure' },
        owner: 'infrastructure', category: 'environment', unit: 'step',
        uses: 'actions/checkout@v7.0.1',
        with: { ref: github('event.repository.default_branch'), 'persist-credentials': false },
      }),
      typedStep({
        name: 'Set up Node',
        doc: { purpose: 'Runs the typed enabler.', recovery: 'retry if the pinned Node runtime is unavailable' },
        owner: 'infrastructure', category: 'environment', unit: 'step',
        uses: 'actions/setup-node@v7.0.0',
        with: { 'node-version': '26.5.0', 'package-manager-cache': false },
      }),
      typedStep({
        id: 'merge-token',
        name: 'Create scoped PR auto-merge token',
        doc: { purpose: 'Uses the installed App so successful merges trigger downstream workflows.', recovery: 'check App pull-request permission' },
        owner: 'automation', category: 'coordination', unit: 'step',
        uses: 'actions/create-github-app-token@v3.2.0',
        with: {
          'app-id': secret('PROMOTION_CHECKPOINT_APP_ID'),
          'private-key': secret('PROMOTION_CHECKPOINT_APP_PRIVATE_KEY'),
          'permission-contents': 'write',
          'permission-pull-requests': 'write',
        },
      }),
      typedStep({
        name: 'Enable GitHub auto-merge for current PR',
        doc: {
          purpose: 'Rechecks the live head, base, draft state and ownership, then requests native auto-merge.',
          recovery: 'inspect the structured decision or App permission error',
        },
        owner: 'automation', category: 'coordination', unit: 'step',
        command: 'node ci/src/actions/enableInternalPrAutoMerge.ts',
        env: { GITHUB_TOKEN: expr('steps.merge-token.outputs.token') },
      }),
    ],
  })],
});
