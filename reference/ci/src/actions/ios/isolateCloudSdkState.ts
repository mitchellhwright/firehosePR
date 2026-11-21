import { createIsolatedCloudSdkState } from '../../ios/cloudSdkState.ts';

import { exportStepEnvBlock } from '../../ios/shared/actionIo.ts';
import { runStep } from '../../ios/shared/stepIo.ts';

/**
 * Gives this job its own `CLOUDSDK_CONFIG`.
 *
 * Several lanes authenticate to GCP on the same self-hosted Mac; a shared
 * gcloud configuration would let one lane's credential outlive its job and be
 * picked up by the next. The cleanup step removes the directory by reading the
 * second marker exported here.
 */

function run(): void {
  const configuration = createIsolatedCloudSdkState(process.env);
  exportStepEnvBlock(
    new Map([
      ['CLOUDSDK_CONFIG', configuration],
      ['EXAMPLE_ISOLATED_CLOUDSDK_CONFIG', configuration],
    ]),
  );
}

await runStep('Isolate Google Cloud SDK state', run);
