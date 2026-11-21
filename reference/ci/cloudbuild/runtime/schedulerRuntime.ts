/** Shared Cloud Scheduler reconciliation; native jobs own execution and retry. */
interface HttpTarget {
  readonly uri: string;
  readonly httpMethod: 'POST';
}
export interface OidcHttpTarget extends HttpTarget {
  readonly oidcToken: { readonly serviceAccountEmail: string; readonly audience: string };
  readonly oauthToken?: never;
}
export interface OAuthHttpTarget extends HttpTarget {
  readonly oauthToken: { readonly serviceAccountEmail: string };
  readonly oidcToken?: never;
}
export interface SchedulerJob {
  readonly name: string;
  readonly schedule: string;
  readonly timeZone: string;
  readonly attemptDeadline?: string;
  readonly retryConfig?: {
    readonly retryCount: number;
    readonly minBackoffDuration: string;
    readonly maxBackoffDuration: string;
  };
  readonly httpTarget: OidcHttpTarget | OAuthHttpTarget;
}
/** Existing bounded worker contracts remain narrower than the shared API model. */
export interface HttpSchedulerJob extends SchedulerJob {
  readonly timeZone: 'UTC';
  readonly attemptDeadline: '300s';
  readonly httpTarget: OidcHttpTarget;
}
export interface SchedulerRuntime<Job extends SchedulerJob> {
  readonly request: (url: string, method: 'GET' | 'POST' | 'PATCH', body?: Job) => Promise<unknown | null>;
  readonly log: (message: string) => void;
}
export function validSchedulerIdentity(inputs: {
  readonly project: string; readonly region: string; readonly serviceAccount: string;
}): boolean {
  return /^[a-z][a-z0-9-]+$/.test(inputs.project) && /^[a-z0-9-]+$/.test(inputs.region)
    && /^[^\s@]+@[^\s@]+\.gserviceaccount\.com$/.test(inputs.serviceAccount);
}
export interface SchedulerInputs {
  readonly project: string;
  readonly region: string;
  readonly audience: string;
  readonly serviceAccount: string;
}
export function validateSchedulerInputs(inputs: SchedulerInputs, serviceUrl?: string): void {
  const https = (value: string): boolean => {
    try {
      const url = new URL(value);
      return url.protocol === 'https:' && !!url.hostname && !url.username && !url.password && !url.search && !url.hash;
    } catch { return false; }
  };
  if (!validSchedulerIdentity(inputs) || !https(inputs.audience)
    || (serviceUrl !== undefined && !https(serviceUrl))) {
    throw new Error('Invalid scheduler inputs');
  }
}
function object(value: unknown): Readonly<Record<string, unknown>> | null {
  return value !== null && typeof value === 'object' ? value as Readonly<Record<string, unknown>> : null;
}
function requireName(value: unknown, name: string): void {
  if (object(value)?.name !== name) throw new Error(`Cloud Scheduler did not confirm ${name}`);
}
function requireApplied(value: unknown, job: SchedulerJob): void {
  requireName(value, job.name);
  const applied = object(value);
  const target = object(applied?.httpTarget);
  const expectedAuth = job.httpTarget.oidcToken ?? job.httpTarget.oauthToken;
  const auth = object(job.httpTarget.oidcToken ? target?.oidcToken : target?.oauthToken);
  const retry = object(applied?.retryConfig);
  if (applied?.schedule !== job.schedule || applied.timeZone !== job.timeZone
    || (job.attemptDeadline !== undefined && applied.attemptDeadline !== job.attemptDeadline)
    || target?.uri !== job.httpTarget.uri || target.httpMethod !== job.httpTarget.httpMethod
    || auth?.serviceAccountEmail !== expectedAuth.serviceAccountEmail
    || (job.httpTarget.oidcToken && auth.audience !== job.httpTarget.oidcToken.audience)
    || (job.retryConfig && (retry?.retryCount !== job.retryConfig.retryCount
      || retry.minBackoffDuration !== job.retryConfig.minBackoffDuration
      || retry.maxBackoffDuration !== job.retryConfig.maxBackoffDuration))) {
    throw new Error(`Cloud Scheduler did not apply ${job.name}`);
  }
}
export function cloudRunServiceUrl(value: unknown): string {
  const uri = object(value)?.uri;
  if (typeof uri !== 'string' || !uri) throw new Error('Cloud Run service has no URL');
  return uri;
}
export async function reconcileHttpScheduler<Job extends SchedulerJob>(
  job: Job, runtime: SchedulerRuntime<Job>,
): Promise<void> {
  const endpoint = `https://cloudscheduler.googleapis.com/v1/${job.name}`;
  const existing = await runtime.request(endpoint, 'GET');
  if (existing !== null) requireName(existing, job.name);
  // Patch only fields this owner supplies; leave native defaults and other state intact.
  const fields = ['schedule', 'timeZone',
    ...(job.attemptDeadline === undefined ? [] : ['attemptDeadline']),
    ...(job.retryConfig === undefined ? [] : ['retryConfig']), 'httpTarget'];
  const result = existing === null
    ? await runtime.request(`https://cloudscheduler.googleapis.com/v1/${job.name.slice(0, job.name.lastIndexOf('/'))}`, 'POST', job)
    : await runtime.request(`${endpoint}?updateMask=${fields.join(',')}`, 'PATCH', job);
  requireApplied(result, job);
  runtime.log(`Reconciled ${job.name}`);
}
export function requiredSchedulerEnvironment(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`Missing ${name}`);
  return value;
}
export async function googleSchedulerRuntime<Job extends SchedulerJob>(): Promise<SchedulerRuntime<Job>> {
  const response = await fetch('http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token', {
    headers: { 'Metadata-Flavor': 'Google' }, signal: AbortSignal.timeout(10_000), redirect: 'error',
  });
  if (!response.ok) throw new Error(`Build metadata authentication failed (${response.status})`);
  const bearer = object(await response.json())?.access_token;
  if (typeof bearer !== 'string' || !bearer) throw new Error('Build metadata returned no access token');
  return {
    log: console.log,
    request: async (url, method, body) => {
      const result = await fetch(url, {
        method, headers: { Authorization: `Bearer ${bearer}`, 'Content-Type': 'application/json' },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: AbortSignal.timeout(30_000), redirect: 'error',
      });
      if (result.status === 404 && method === 'GET') return null;
      if (!result.ok) throw new Error(`Google API ${method} failed (${result.status})`);
      const value: unknown = await result.json();
      return value;
    },
  };
}
