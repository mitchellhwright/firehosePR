import type { CloudBuildStep } from './types.ts';

export const primarySmokeCliImage = 'docker:29.5.3-cli';
export const primarySmokeCliPath = '/workspace/.example-primary-smoke-docker';
export const primarySmokeNodeImage = 'node:26.5.1-alpine';
export const primarySmokeProgram = 'ci/cloudbuild/runtime/primaryContainerSmoke.ts';

/** Native bootstrap only: share the pinned CLI binary with the Node step. */
export function primarySmokeSteps<Id extends string>(input: {
  readonly prepare: Id;
  readonly build: Id;
  readonly smoke: Id;
  readonly image: string;
}): readonly [CloudBuildStep<Id>, CloudBuildStep<Id>] {
  return [{
    id: input.prepare, name: primarySmokeCliImage, entrypoint: 'cp',
    args: ['/usr/local/bin/docker', primarySmokeCliPath], waitFor: [input.build],
  }, {
    id: input.smoke, name: primarySmokeNodeImage, entrypoint: 'node',
    args: [primarySmokeProgram, input.image], waitFor: [input.build, input.prepare],
    env: [`PRIMARY_CONTAINER_DOCKER=${primarySmokeCliPath}`], timeout: '300s',
  }];
}
