import { z } from 'zod';
import { derivePromotionVerdict } from '../../ios/promotionVerdict.ts';
import { renderedEnvironmentValue } from '../../ios/shared/jobResults.ts';
import { runStepProgram } from '../../ios/shared/stepDecision.ts';

const environmentSchema = z.object({
  EVENT_NAME: renderedEnvironmentValue,
  BASE_BRANCH: renderedEnvironmentValue,
  HEAD_BRANCH: renderedEnvironmentValue,
  REPOSITORY: renderedEnvironmentValue,
  HEAD_REPOSITORY: renderedEnvironmentValue,
  CHANGE_GATE_RESULT: renderedEnvironmentValue,
  PROMOTION_CHECKPOINT_SHA: renderedEnvironmentValue,
  PROMOTION_PROVEN: renderedEnvironmentValue,
  PROMOTION_RUN_ID: renderedEnvironmentValue,
});

runStepProgram('Exact-develop promotion verdict', () => {
  const environment = environmentSchema.parse(process.env);
  return derivePromotionVerdict({
    eventName: environment.EVENT_NAME,
    baseBranch: environment.BASE_BRANCH,
    headBranch: environment.HEAD_BRANCH,
    repository: environment.REPOSITORY,
    headRepository: environment.HEAD_REPOSITORY,
    changeGateResult: environment.CHANGE_GATE_RESULT,
    checkpointSha: environment.PROMOTION_CHECKPOINT_SHA,
    proven: environment.PROMOTION_PROVEN,
    runId: environment.PROMOTION_RUN_ID,
  });
});
