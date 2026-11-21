import { z } from 'zod';

import {
  checkLifecycleOutcomes,
  dashboardOfflineEvidenceArguments,
} from '../../ios/onboardingLifecycleEvidence.ts';
import { runCommand } from '../../ios/shared/processRunner.ts';
import { renderStepMessage } from '../../ios/shared/stepDecision.ts';
import { readStepEnvironment } from '../../ios/shared/stepEnvironment.ts';
import { runStep } from '../../ios/shared/stepIo.ts';

/**
 * Fails the FullOnboarding lane unless provisioning, the journey and its
 * offline proxy succeeded, then validates their evidence.
 *
 * The cleanup step is `continue-on-error`, so without this gate a leaked
 * synthetic user produces a warning without changing the product verdict.
 * The outcomes arrive through `env:` because a step cannot read another
 * step's outcome any other way.
 */

const environmentSchema = z.object({
  PROVISION_OUTCOME: z.string(),
  PROXY_START_OUTCOME: z.string(),
  ONBOARDING_OUTCOME: z.string(),
  PROXY_STOP_OUTCOME: z.string(),
  CLEANUP_OUTCOME: z.string(),
  DASHBOARD_OFFLINE_PROXY_EVENTS: z.string().min(1),
  DEVELOPMENT_FULL_ONBOARDING_CLEANUP_EVIDENCE: z.string().min(1),
  ONBOARDING_E2E_XCODEBUILD_LOG: z.string().min(1),
  ONBOARDING_E2E_RESULT_BUNDLE: z.string().min(1),
  ONBOARDING_E2E_COMMIT_SHA: z.string().min(1),
  DASHBOARD_OFFLINE_EVIDENCE_JSON: z.string().min(1),
});

await runStep('Development FullOnboarding evidence validation', async () => {
  const environment = readStepEnvironment(environmentSchema);
  const verdict = checkLifecycleOutcomes(environment);
  for (const message of verdict.messages) process.stdout.write(`${renderStepMessage(message)}\n`);
  if (verdict.exitCode !== 0) {
    process.exitCode = verdict.exitCode;
    return;
  }

  const result = await runCommand('node', dashboardOfflineEvidenceArguments({
    events: environment.DASHBOARD_OFFLINE_PROXY_EVENTS,
    cleanup: environment.DEVELOPMENT_FULL_ONBOARDING_CLEANUP_EVIDENCE,
    xcodeLog: environment.ONBOARDING_E2E_XCODEBUILD_LOG,
    xcresult: environment.ONBOARDING_E2E_RESULT_BUNDLE,
    sha: environment.ONBOARDING_E2E_COMMIT_SHA,
    output: environment.DASHBOARD_OFFLINE_EVIDENCE_JSON,
  }));
  if (result.status !== 0) process.exitCode = result.status;
});
