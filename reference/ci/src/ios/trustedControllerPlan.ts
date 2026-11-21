import { error, notice, type StepMessage } from './shared/stepDecision.ts';

/**
 * Whether a control step may run a controller it took from the trusted base.
 *
 * iOS control steps check out a program at the pull request's base SHA and
 * then run it. Each one first has to answer the same two questions — is this
 * really the revision we asked for, and does that revision actually carry the
 * program? A missing base-update classifier is a normal state during rollout,
 * so its absence keeps full routing rather than failing.
 *
 * The answers are plans rather than side effects: a list of lines to print, a
 * program to run or `null`, and the status the step ends with. Nothing here
 * reads a file or spawns anything, so every branch is exercised directly in
 * `ci/tests/trustedControllerPlan.test.ts`.
 */

export interface ControllerPlan {
  /** Printed in order before anything runs, exactly as the shell echoed them. */
  readonly messages: readonly StepMessage[];
  /** The program to run once the messages are printed, or `null` to stop here. */
  readonly run: string | null;
  readonly exitCode: 0 | 1;
}

/**
 * A checkout that is not the exact revision the step asked for. Comparing the
 * strings is the whole check: `git rev-parse HEAD` already resolved the
 * checkout to a full SHA, and the expected value came from the event.
 */
export function checkoutRevisionMatches(expected: string, checkedOut: string): boolean {
  return expected.length > 0 && expected === checkedOut;
}

export interface TrustedCheckoutInput {
  readonly expectedSha: string;
  readonly checkedOutSha: string;
}

function mismatch(subject: string, input: TrustedCheckoutInput): ControllerPlan {
  return {
    messages: [
      error(
        `${subject} checkout mismatch: expected ${input.expectedSha}, found ${input.checkedOutSha}.`,
      ),
    ],
    run: null,
    exitCode: 1,
  };
}

export interface BaseUpdateClassifierInput extends TrustedCheckoutInput {
  readonly classifierPath: string;
  readonly classifierExists: boolean;
}

/**
 * The incremental head-delta classifier. A base that predates the classifier
 * simply leaves the new head on full affected-file routing, so its absence is
 * a notice and a success — never a failure that would block the pull request
 * on a rollout boundary.
 */
export function baseUpdateClassifierPlan(input: BaseUpdateClassifierInput): ControllerPlan {
  if (!checkoutRevisionMatches(input.expectedSha, input.checkedOutSha)) {
    return mismatch('Trusted base-update', input);
  }
  const located = notice(
    `Trusted base-update classifier checkout: ${input.checkedOutSha} at ${input.classifierPath}.`,
  );
  if (!input.classifierExists) {
    return {
      messages: [
        located,
        notice(
          `Exact base ${input.expectedSha} has no trusted classifier at ${input.classifierPath}; ` +
            'retaining full iOS routing.',
        ),
      ],
      run: null,
      exitCode: 0,
    };
  }
  return { messages: [located], run: input.classifierPath, exitCode: 0 };
}

/**
 * The bare revision comparison two steps made with `test`, which failed
 * without saying anything. `subject` names the revision that was expected —
 * "exact head" for a Mac lane about to allocate Xcode, "trusted base" for a
 * checkout about to be run against the shared database — and the wording is
 * the one the consolidated execution lane already prints, so the lanes report
 * an identical mismatch.
 */
export function exactRevisionPlan(input: TrustedCheckoutInput, subject: string): ControllerPlan {
  if (checkoutRevisionMatches(input.expectedSha, input.checkedOutSha)) {
    return { messages: [], run: null, exitCode: 0 };
  }
  return {
    messages: [
      error(`Checked out ${input.checkedOutSha}, expected ${subject} ${input.expectedSha}.`),
    ],
    run: null,
    exitCode: 1,
  };
}
