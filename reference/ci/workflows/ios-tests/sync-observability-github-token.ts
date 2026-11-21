import { expr, github, secret, typedJob, typedStep } from '../lib/index.ts';
import { controlLane, setupNode, trustedControlRunner, typedLayerCheckout } from './shared.ts';

/**
 * Publish the GitHub credential the observability dashboard reads.
 *
 * The dashboard runs in Cloud Run and reads its GitHub token from Secret
 * Manager, which nothing else in the repository writes; this job is how a new
 * repository secret reaches it. It is dispatched by hand, one scope of this
 * workflow, and is the only job here that touches a deployment environment
 * without allocating a runner anyone else is waiting for.
 */

const gcpAuth = typedStep({
  id: 'gcp-auth',
  name: 'Authenticate to GCP',
  doc: {
    purpose: 'Exchanges the run identity for a short-lived GCP access token through workload identity.',
    recovery: 'check the workload identity provider still trusts this repository and the service account',
  },
  owner: 'iam',
  category: 'environment',
  unit: 'step',
  outputs: ['access_token'] as const,
  uses: 'google-github-actions/auth@v3',
  with: {
    project_id: 'example-app',
    workload_identity_provider:
      'projects/123456789012/locations/global/workloadIdentityPools/github-actions/providers/github',
    service_account: 'github-actions-ci@example-app.iam.gserviceaccount.com',
    token_format: 'access_token',
    create_credentials_file: false,
  },
});

/**
 * The credential never reaches a command line: the typed step builds the
 * Secret Manager request as a value and sends it with fetch, where the curl
 * it replaced took the base64 payload as an argument any other process on the
 * runner could read.
 */
const addCredentialVersion = typedStep({
  name: 'Add the current credential version',
  doc: {
    purpose: 'Adds the repository secret as a new version of the Secret Manager secret the dashboard reads.',
    recovery: 'read the Secret Manager error the step prints; it names the project and secret it addressed',
  },
  owner: 'iam',
  category: 'environment',
  unit: 'step',
  command: 'node .ci/observability-credential-sync/ci/src/actions/ios/syncObservabilityCredential.ts',
  env: {
    GCP_PROJECT: 'example-app',
    SECRET_NAME: 'OBSERVABILITY_GITHUB_TOKEN',
    OBSERVABILITY_GITHUB_TOKEN: secret('OBSERVABILITY_GITHUB_TOKEN'),
    GCP_ACCESS_TOKEN: gcpAuth.outputs.access_token,
  },
});

export const syncObservabilityGithubToken = typedJob('sync-observability-github-token', {
  name: 'Sync observability GitHub credential',
  doc: {
    purpose: 'Copies the repository GitHub credential into the Secret Manager secret the dashboard reads.',
    successMeaning: 'The observability dashboard now reads the current GitHub credential.',
  },
  owner: 'iam',
  category: 'environment',
  unit: 'job',
  if: expr("github.event_name == 'workflow_dispatch' && inputs.test_scope == 'observability-credential-sync'"),
  // A single Secret Manager API call. It runs on the trusted control runners
  // (any architecture: no Cloud SDK download) rather than a hosted runner that
  // bills a full minute for a few seconds of work.
  runsOn: trustedControlRunner,
  environment: 'development-e2e',
  permissions: { contents: 'read', 'id-token': 'write' },
  lane: controlLane,
  steps: [
    typedLayerCheckout({
      name: 'Checkout typed credential sync',
      path: '.ci/observability-credential-sync',
      // This job carries no pull request, so the dispatched revision is the
      // one to run: there is no base to fall back to.
      ref: github('sha'),
    }),
    setupNode('Setup Node for the typed credential sync'),
    gcpAuth,
    addCredentialVersion,
  ],
});
