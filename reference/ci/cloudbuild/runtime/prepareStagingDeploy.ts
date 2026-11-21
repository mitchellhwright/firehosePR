import { writeFile } from 'node:fs/promises';
import { prepareStagingDeployFlags, validateStagingDeployInputs, probeStagingSecret } from './stagingDeployFlags.ts';

try {
  const inputs = { project: process.env.GCP_PROJECT_ID ?? '', commitSha: process.env.COMMIT_SHA ?? '',
    buildId: process.env.CLOUD_BUILD_ID ?? '' };
  validateStagingDeployInputs(inputs);
  const metadata = await fetch('http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token', {
    headers: { 'Metadata-Flavor': 'Google' }, redirect: 'error', signal: AbortSignal.timeout(10_000),
  });
  if (!metadata.ok) throw new Error(`Build metadata authentication failed (${metadata.status})`);
  const token: unknown = await metadata.json();
  if (token === null || typeof token !== 'object' || !('access_token' in token)
    || typeof token.access_token !== 'string' || !token.access_token) throw new Error('Build metadata returned no access token');
  const bearer = token.access_token;
  const flags = await prepareStagingDeployFlags(inputs, {
    log: console.log,
    accessible: secret => probeStagingSecret(inputs.project, bearer, secret),
  });
  await writeFile('/workspace/example-runtime-deploy-flags.json', JSON.stringify(flags) + '\n', { mode: 0o600 });
} catch (error) {
  console.error(error instanceof Error ? error.message : 'Staging deployment preparation failed');
  process.exitCode = 1;
}
