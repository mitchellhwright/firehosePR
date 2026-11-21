import { optionalEnv, requiredEnv } from '../../ios/shared/actionIo.ts';
import { appendStepOutputs } from '../../ios/shared/githubOutputs.ts';
import { StepFailure } from '../../ios/shared/stepFailure.ts';
import { runStep } from '../../ios/shared/stepIo.ts';
import { nativeProductBuildDecision } from '../../ios/testProductHandoff.ts';

/**
 * `Resolve native product build mode`.
 *
 * Widens the prepared selection to the narrowest scope whose compiled products
 * every selected consumer can trust, and decides whether the `CI-Evidence`
 * test plan has to be compiled alongside the main one. The decision itself
 * lives in `ci/src/ios/testProductHandoff.ts`; this program only reads the
 * step's inputs and writes its two outputs.
 */
await runStep('Native product build mode', () => {
  const decision = nativeProductBuildDecision({
    preparedSelectionMode: requiredEnv('PREPARED_SELECTION_MODE'),
    preparedUiRequired: optionalEnv('PREPARED_UI_REQUIRED'),
    preparedEvidenceGroups: optionalEnv('PREPARED_EVIDENCE_GROUPS'),
    preparedNarrowPaywallRequired: requiredEnv('PREPARED_NARROW_PAYWALL_REQUIRED'),
    forcedExecutionLanes: requiredEnv('FORCED_EXECUTION_LANES'),
    fullExecutionLanes: requiredEnv('FULL_EXECUTION_LANES'),
  });
  if (decision.kind === 'error') throw new StepFailure(`::error::${decision.message}`);

  appendStepOutputs([
    ['mode', decision.mode],
    ['evidence_plan_required', String(decision.evidencePlanRequired)],
  ]);
});
