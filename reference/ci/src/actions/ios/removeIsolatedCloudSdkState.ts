import { removeIsolatedCloudSdkState } from '../../ios/cloudSdkState.ts';
import { logLine } from '../../ios/shared/actionIo.ts';
import { runStep } from '../../ios/shared/stepIo.ts';

await runStep('Remove isolated Google Cloud SDK state', () => {
  logLine(JSON.stringify({ event: 'isolated-cloud-sdk-cleanup', decision: removeIsolatedCloudSdkState(process.env) }));
});
