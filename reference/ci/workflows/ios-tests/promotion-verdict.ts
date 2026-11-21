import {
  ciEventField, expr, github, typedStep,
} from '../lib/index.ts';
import { iosGateOutput } from './shared.ts';

/** Shared status step; each required context keeps its GitHub-native name. */
export const promotionVerdictAt = (checkoutPath = '') => typedStep({
  name: 'Verify exact-develop promotion verdict',
  doc: {
    purpose: 'Accepts only the trusted gate proof of completed exact-develop iOS execution.',
    recovery: 'complete the missing checkpoint coverage and rerun this promotion check',
  },
  owner: 'product',
  category: 'quality',
  unit: 'step',
  if: expr("needs.ios-change-gate.outputs.production_promotion == 'true'"),
  env: {
    EVENT_NAME: github('event_name'),
    BASE_BRANCH: ciEventField('baseBranch'),
    HEAD_BRANCH: ciEventField('headBranch'),
    REPOSITORY: github('repository'),
    HEAD_REPOSITORY: ciEventField('headRepository'),
    CHANGE_GATE_RESULT: expr('needs.ios-change-gate.result'),
    PROMOTION_CHECKPOINT_SHA: iosGateOutput('promotion_checkpoint_sha'),
    PROMOTION_PROVEN: iosGateOutput('promotion_proven'),
    PROMOTION_RUN_ID: iosGateOutput('promotion_run_id'),
  },
  command: `node ${checkoutPath ? `${checkoutPath}/` : ''}ci/src/actions/ios/verifyPromotionVerdict.ts`,
});

export const promotionVerdict = promotionVerdictAt();
