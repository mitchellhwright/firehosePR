import { z } from 'zod';

import { renderedEnvironmentValue } from '../../ios/shared/jobResults.ts';
import { runStepProgram } from '../../ios/shared/stepDecision.ts';
import { deriveNativeTestLaneStatus } from '../../ios/nativeTestLaneStatus.ts';

/**
 * "Verify iOS test lanes": the required `Test - iOS` context.
 *
 * Every input keeps the env name the replaced shell read. Absent values
 * default to the empty string, which is what GitHub renders for a
 * `needs.<job>.result` or gate output the run never produced; the decision
 * module then applies the same `${VAR:-default}` substitutions the shell did,
 * so an absent value can never read as a pass it did not earn.
 */
const environmentSchema = z.object({
  EVENT_NAME: renderedEnvironmentValue,
  TEST_SCOPE: renderedEnvironmentValue,
  DISPATCH_REF: renderedEnvironmentValue,
  REPOSITORY: renderedEnvironmentValue,
  HEAD_REPOSITORY: renderedEnvironmentValue,
  BASE_BRANCH: renderedEnvironmentValue,
  BASE_UPDATE_DEFERRED: renderedEnvironmentValue,
  CHANGE_GATE_RESULT: renderedEnvironmentValue,
  CHANGE_GATE_SHOULD_RUN: renderedEnvironmentValue,
  MAC_RUNNER_RESOLUTION_RESULT: renderedEnvironmentValue,
  NATIVE_PREPARATION_RESULT: renderedEnvironmentValue,
  NATIVE_BUILD_RESULT: renderedEnvironmentValue,
  NATIVE_EXECUTION_REQUIRED: renderedEnvironmentValue,
  RELEASE_ARCHIVE_REQUIRED: renderedEnvironmentValue,
  RELEASE_ARCHIVE_RESULT: renderedEnvironmentValue,
  MAIN_EXECUTION_RESULT: renderedEnvironmentValue,
  MAIN_REQUIRED: renderedEnvironmentValue,
  EVIDENCE_REQUIRED: renderedEnvironmentValue,
});

runStepProgram('Native iOS test lane verification', () => {
  const environment = environmentSchema.parse(process.env);
  return deriveNativeTestLaneStatus({
    eventName: environment.EVENT_NAME,
    testScope: environment.TEST_SCOPE,
    dispatchRef: environment.DISPATCH_REF,
    repository: environment.REPOSITORY,
    headRepository: environment.HEAD_REPOSITORY,
    baseBranch: environment.BASE_BRANCH,
    baseUpdateDeferred: environment.BASE_UPDATE_DEFERRED,
    changeGateResult: environment.CHANGE_GATE_RESULT,
    changeGateShouldRun: environment.CHANGE_GATE_SHOULD_RUN,
    macRunnerResolutionResult: environment.MAC_RUNNER_RESOLUTION_RESULT,
    nativePreparationResult: environment.NATIVE_PREPARATION_RESULT,
    nativeBuildResult: environment.NATIVE_BUILD_RESULT,
    nativeExecutionRequired: environment.NATIVE_EXECUTION_REQUIRED,
    releaseArchiveRequired: environment.RELEASE_ARCHIVE_REQUIRED,
    releaseArchiveResult: environment.RELEASE_ARCHIVE_RESULT,
    mainExecutionResult: environment.MAIN_EXECUTION_RESULT,
    mainRequired: environment.MAIN_REQUIRED,
    evidenceRequired: environment.EVIDENCE_REQUIRED,
  });
});
