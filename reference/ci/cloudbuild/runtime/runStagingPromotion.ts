import { setTimeout } from 'node:timers/promises';
import { performance } from 'node:perf_hooks';
import {
  promoteStaging,
  verifyBuildOwnership,
  verifyStaging,
  type PromotionInputs,
  type PromotionRuntime,
} from './stagingPromotion.ts';

function input(name: string, pattern: RegExp): string {
  const value = process.env[name];
  if (!value || !pattern.test(value)) throw new Error(`Missing or invalid ${name}`);
  return value;
}
const inputs: PromotionInputs = {
  project: input('GCP_PROJECT_ID', /^[a-z][a-z0-9-]+$/),
  region: input('GCP_REGION', /^[a-z0-9-]+$/),
  service: input('CLOUD_RUN_SERVICE', /^[a-z][a-z0-9-]+$/),
  buildId: input('CLOUD_BUILD_ID', /^[a-f0-9-]+$/),
  commitSha: input('COMMIT_SHA', /^[a-f0-9]{40}$/),
  healthUrl: input('STAGING_HEALTH_URL', /^https:\/\/s\.examplewealth\.com\/api\/health$/),
};
const now = () => performance.now();
function signal(deadline: number): AbortSignal {
  const remaining = deadline - now();
  if (remaining <= 0) throw new Error('Deployment verification deadline exhausted');
  return AbortSignal.timeout(Math.max(1, Math.min(10_000, Math.floor(remaining))));
}
let token: string | undefined;
async function accessToken(deadline: number): Promise<string> {
  if (token) return token;
  // Cloud Build exposes the build service account through its metadata server.
  // Keep the credential in memory; never print it or write it to the shared workspace.
  const response = await fetch(
    'http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token',
    {
      headers: { 'Metadata-Flavor': 'Google' },
      signal: signal(deadline),
      redirect: 'error',
    }
  );
  if (!response.ok) throw new Error(`Build metadata authentication failed (${response.status})`);
  const value: unknown = await response.json();
  if (
    value === null ||
    typeof value !== 'object' ||
    !('access_token' in value) ||
    typeof value.access_token !== 'string' ||
    !value.access_token
  ) {
    throw new Error('Build metadata returned no access token');
  }
  token = value.access_token;
  return token;
}
const runtime: PromotionRuntime = {
  now,
  sleep: async (milliseconds) => {
    await setTimeout(milliseconds);
  },
  log: console.log,
  request: async (url, deadline, body) => {
    const bearer = await accessToken(deadline);
    const response = await fetch(url, {
      method: body === undefined ? 'GET' : 'PATCH',
      headers: { Authorization: `Bearer ${bearer}`, 'Content-Type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: signal(deadline),
      redirect: 'error',
    });
    if (!response.ok) throw new Error(`Deployment API request failed (${response.status})`);
    return response.json();
  },
  health: async (url, deadline) => {
    const response = await fetch(url, {
      signal: signal(deadline),
      redirect: 'error',
      headers: { 'Cache-Control': 'no-store' },
    });
    if (!response.ok) throw new Error(`Staging health request failed (${response.status})`);
    return response.json();
  },
};
try {
  if (process.argv[2] === 'ownership') await verifyBuildOwnership(inputs, runtime);
  else if (process.argv[2] === 'promote') await promoteStaging(inputs, runtime);
  else if (process.argv[2] === 'verify') await verifyStaging(inputs, runtime);
  else throw new Error('usage: runStagingPromotion.ts ownership|promote|verify');
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
