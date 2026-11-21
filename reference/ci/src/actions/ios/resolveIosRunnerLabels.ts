import { z } from 'zod';

import { resolveIosRunnerLabels } from '../../ios/iosRunnerLabels.ts';
import { StepFailure } from '../../ios/shared/stepFailure.ts';
import {
  appendStepOutputs,
  optionalEnv,
  requiredEnv,
  runStep,
  writeAnnotation,
  type StepOutput,
} from '../../ios/shared/stepIo.ts';

/**
 * `ios-change-gate` → `Resolve iOS macOS runner labels`.
 *
 * Admits this run to the reviewed macOS runner group and publishes the labels
 * and disk floors every Mac job pins. The rules live in
 * `ci/src/ios/iosRunnerLabels.ts`; this program reads the step's `env:` and
 * writes the outputs and notices.
 */

const environmentSchema = z.object({
  IOS_MACOS_RUNNER_LABELS: z.string(),
  IOS_EVIDENCE_MACOS_RUNNER_LABELS: z.string(),
  IOS_ONBOARDING_MACOS_RUNNER_LABELS: z.string(),
  IOS_CHAT_PLAID_MACOS_RUNNER_LABELS: z.string(),
  IOS_BUDGET_MACOS_RUNNER_LABELS: z.string(),
  EVENT_NAME: z.string().default(''),
  HEAD_REPOSITORY: z.string().default(''),
  GITHUB_REF: z.string().default(''),
  TEST_SCOPE: z.string().default(''),
  MAC_RUNNER: z.string().default('shared'),
});

/** The keys the gate job reads back off this step, in the order they are written. */
const publishedOutputKeys = [
  'ios_macos_runner_labels',
  'ios_evidence_macos_runner_labels',
  'ios_onboarding_macos_runner_labels',
  'ios_chat_plaid_macos_runner_labels',
  'ios_budget_macos_runner_labels',
  'ios_macos_minimum_free_kb',
  'ios_macos_minimum_execution_free_kb',
  'ios_evidence_macos_minimum_free_kb',
  'ios_evidence_macos_minimum_execution_free_kb',
] as const;

function publish(outputs: readonly StepOutput[]): void {
  const written = outputs.map((output) => output.key);
  if (written.join(',') !== publishedOutputKeys.join(',')) {
    throw new StepFailure(
      `::error::Resolve iOS macOS runner labels wrote [${written.join(', ')}] but the gate reads `
      + `[${publishedOutputKeys.join(', ')}].`,
    );
  }
  appendStepOutputs(outputs);
}

await runStep('Typed iOS macOS runner resolution', () => {
  const environment = environmentSchema.parse(process.env);
  const resolution = resolveIosRunnerLabels(
    {
      main: environment.IOS_MACOS_RUNNER_LABELS,
      evidence: environment.IOS_EVIDENCE_MACOS_RUNNER_LABELS,
      onboarding: environment.IOS_ONBOARDING_MACOS_RUNNER_LABELS,
      chatPlaid: environment.IOS_CHAT_PLAID_MACOS_RUNNER_LABELS,
      budget: environment.IOS_BUDGET_MACOS_RUNNER_LABELS,
    },
    {
      eventName: environment.EVENT_NAME,
      headRepository: environment.HEAD_REPOSITORY,
      // Only a pull request consults it, and `${GITHUB_REPOSITORY:?}` demanded
      // it be set when one does.
      githubRepository: environment.EVENT_NAME === 'pull_request'
        ? requiredEnv('GITHUB_REPOSITORY')
        : optionalEnv('GITHUB_REPOSITORY'),
      githubRef: environment.GITHUB_REF,
      testScope: environment.TEST_SCOPE,
      macRunner: environment.MAC_RUNNER,
    },
  );
  publish(resolution.outputs);
  for (const notice of resolution.notices) writeAnnotation(notice);
});
