import { trustedControlLinuxRunnerLabels } from '../src/runnerPolicy.ts';
import { expr, typedJob, typedStep, typedWorkflow } from './lib/index.ts';
import { mergedTerminalGroup } from './lib/validationConcurrency.ts';

/**
 * A merged PR enters the same repository-wide concurrency group as the
 * validation run. Merged PRs cannot reopen, so a delayed event cannot cancel
 * a fresh run. Other close events use a unique group; the state-checking API
 * cleanup owns them. The signal job never allocates a runner.
 */
function terminalSignal(
  group: ReturnType<typeof mergedTerminalGroup>,
  path: `.github/workflows/${string}.yml`,
  name: string,
) {
  const signal = typedJob('terminal-signal', {
    name: 'Cancel terminal PR validation natively',
    doc: {
      purpose: 'Lets GitHub cancel validation in the matching PR concurrency group without starting a runner.',
      successMeaning: 'The signal job is skipped; cancellation is handled by GitHub concurrency.',
    },
    owner: 'infrastructure',
    category: 'coordination',
    unit: 'job',
    if: expr("github.event.action == 'opened'"),
    runsOn: trustedControlLinuxRunnerLabels,
    timeoutMinutes: 1,
    lane: {
      runnerClass: 'linux-self-hosted',
      costClass: 'control',
      evidencePolicy: 'none',
      selectionOwner: 'controller',
    },
    // GitHub requires a job body, but this trigger never has action `opened`,
    // so the condition prevents checkout and runner allocation.
    // A future accidental execution is read-only.
    steps: [typedStep({
      name: 'Read repository metadata',
      doc: { purpose: 'A read-only placeholder for GitHub job syntax.', recovery: 'restore the skipped job condition' },
      owner: 'infrastructure',
      category: 'coordination',
      unit: 'step',
      uses: 'actions/checkout@v7.0.1',
      with: { 'persist-credentials': false },
    })],
  });

  return typedWorkflow({
    path,
    source: 'ci/workflows/native-terminal-pr-cancel.ts',
    name,
    doc: { purpose: 'Cancels obsolete PR validation immediately when a pull request merges.' },
    on: { pull_request_target: { types: ['closed'] } },
    permissions: { contents: 'read' },
    concurrency: {
      group,
      cancelInProgress: true,
    },
    jobs: [signal],
  });
}

export const nativeTerminalPrChecksCancel = terminalSignal(
  mergedTerminalGroup('pr-checks'),
  '.github/workflows/native-terminal-pr-checks-cancel.yml',
  'Cancel terminal PR Checks',
);

export const nativeTerminalIosCancel = terminalSignal(
  mergedTerminalGroup('ios'),
  '.github/workflows/native-terminal-ios-cancel.yml',
  'Cancel terminal iOS validation',
);
