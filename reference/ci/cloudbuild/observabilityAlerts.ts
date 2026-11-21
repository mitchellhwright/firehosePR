import type { CloudBuildTarget } from './lib/emit.ts';
import type { CloudBuild } from './lib/types.ts';

type ObservabilityAlertsStepId = 'build-image';

export const observabilityAlertsTarget: CloudBuildTarget = {
  path: 'cloudbuild-observability-alerts.yaml',
  source: 'ci/cloudbuild/observabilityAlerts.ts',
};

const image = '${_REGION}-docker.pkg.dev/$PROJECT_ID/${_ARTIFACT_REPOSITORY}/observability-alerts:$BUILD_ID';

/** Build an immutable image only; deployment requires a separately verified digest. */
export const observabilityAlertsBuild = {
  steps: [{
    name: 'gcr.io/cloud-builders/docker',
    id: 'build-image',
    args: [
      'build', '--platform=linux/amd64', '-f', 'Dockerfile.observability-alerts',
      '-t', image, '.',
    ],
  }],
  images: [image],
  options: { logging: 'CLOUD_LOGGING_ONLY' },
  substitutions: {
    _REGION: 'us-central1',
    _ARTIFACT_REPOSITORY: 'example',
  },
} as const satisfies CloudBuild<ObservabilityAlertsStepId>;
