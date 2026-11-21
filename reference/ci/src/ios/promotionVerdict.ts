import { error, fail, info, pass, type StepDecision } from './shared/stepDecision.ts';

export interface PromotionVerdictInput {
  readonly eventName: string;
  readonly baseBranch: string;
  readonly headBranch: string;
  readonly repository: string;
  readonly headRepository: string;
  readonly changeGateResult: string;
  readonly checkpointSha: string;
  readonly proven: string;
  readonly runId: string;
}

/** A required context can reuse only the trusted gate's exact-develop proof. */
export function derivePromotionVerdict(input: PromotionVerdictInput): StepDecision {
  if (!/^[a-f0-9]{40}$/u.test(input.checkpointSha)
    || input.eventName !== 'pull_request' || input.baseBranch !== 'main'
    || input.headRepository !== input.repository
    || input.headBranch !== `promotion/develop-${input.checkpointSha}`) {
    return fail(error('The promotion evidence verdict lacks an admitted exact checkpoint identity.'));
  }
  if (input.changeGateResult !== 'success' || input.proven !== 'true'
    || !/^[1-9][0-9]*$/u.test(input.runId)) {
    return fail(error('The trusted iOS gate did not prove exact-develop native, StoreKit, onboarding and Release execution.'));
  }
  return pass(info(`Exact-develop iOS obligations passed in run ${input.runId}.`));
}
