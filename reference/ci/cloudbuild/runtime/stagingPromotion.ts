/** Cloud Run PATCH returns an operation; acceptance is not completed traffic reconciliation. */
export interface PromotionInputs {
  readonly project: string;
  readonly region: string;
  readonly service: string;
  readonly buildId: string;
  readonly commitSha: string;
  readonly healthUrl: string;
}
export interface PromotionRuntime {
  readonly now: () => number;
  readonly sleep: (milliseconds: number) => Promise<void>;
  readonly request: (url: string, deadline: number, body?: unknown) => Promise<unknown>;
  readonly health: (url: string, deadline: number) => Promise<unknown>;
  readonly log: (message: string) => void;
}
export const operationTimeoutMs = 300_000;
export const healthTimeoutMs = 120_000;
export const ownershipTimeoutMs = 60_000;
const pollIntervalMs = 2_000;

function record(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}
function requiredString(value: unknown, label: string): string {
  if (typeof value !== 'string' || !value) throw new Error(`${label} must be a nonempty string`);
  return value;
}
function timestamp(value: unknown): bigint {
  const text = requiredString(value, 'Build createTime');
  const match = /^(\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d)(?:\.(\d{1,9}))?Z$/.exec(text);
  if (!match?.[1] || !Number.isFinite(Date.parse(text)))
    throw new Error('Invalid build createTime');
  return BigInt(Date.parse(`${match[1]}Z`)) * 1_000_000n + BigInt((match[2] ?? '').padEnd(9, '0'));
}

async function checkOwner(
  inputs: PromotionInputs,
  runtime: PromotionRuntime,
  deadline: number
): Promise<boolean> {
  const base = `https://cloudbuild.googleapis.com/v1/projects/${inputs.project}/builds`;
  const current = record(
    await runtime.request(`${base}/${inputs.buildId}`, deadline),
    'Current build'
  );
  const trigger = requiredString(current.buildTriggerId, 'Build trigger ID');
  const created = timestamp(current.createTime);
  let pageToken = '';
  const tokens = new Set<string>();
  let found = false;
  do {
    // Filter to the time interval relevant to supersession; the current build must be included.
    const query = new URLSearchParams({
      pageSize: '1000',
      filter: `create_time>="${String(current.createTime)}"`,
    });
    if (pageToken) query.set('pageToken', pageToken);
    const page = record(await runtime.request(`${base}?${query}`, deadline), 'Build list');
    if (!Array.isArray(page.builds)) throw new Error('Cloud Build returned no build list');
    for (const raw of page.builds) {
      const build = record(raw, 'Build');
      if (build.buildTriggerId !== trigger) continue;
      const id = requiredString(build.id, 'Build ID');
      const time = timestamp(build.createTime);
      if (id === inputs.buildId) {
        if (time !== created) throw new Error('Current build metadata changed');
        found = true;
      }
      if (time > created)
        throw new Error(`Superseded by newer build ${id}; stopping staging promotion`);
    }
    pageToken =
      page.nextPageToken === undefined || page.nextPageToken === ''
        ? ''
        : requiredString(page.nextPageToken, 'Next page token');
    if (pageToken && tokens.has(pageToken))
      throw new Error('Cloud Build repeated a pagination token');
    tokens.add(pageToken);
  } while (pageToken);
  return found;
}

async function requireOwner(
  inputs: PromotionInputs,
  runtime: PromotionRuntime,
  deadline: number
): Promise<void> {
  if (!(await checkOwner(inputs, runtime, deadline)))
    throw new Error('Cloud Build response did not contain the current build');
}

export async function verifyBuildOwnership(
  inputs: PromotionInputs,
  runtime: PromotionRuntime
): Promise<void> {
  const deadline = runtime.now() + ownershipTimeoutMs;
  for (;;) {
    if (await checkOwner(inputs, runtime, deadline)) {
      runtime.log(`Build ${inputs.buildId} owns the staging deployment trigger`);
      return;
    }
    await pause(runtime, deadline, ownershipTimeoutMs, 'Cloud Build ownership visibility');
  }
}

function serviceName(inputs: PromotionInputs): string {
  return `projects/${inputs.project}/locations/${inputs.region}/services/${inputs.service}`;
}
function candidateRevision(inputs: PromotionInputs): string {
  return `${inputs.service}-${inputs.commitSha.slice(0, 12)}-${inputs.buildId.split('-')[0]}`;
}
async function requireCandidate(
  inputs: PromotionInputs,
  runtime: PromotionRuntime,
  deadline: number
): Promise<Record<string, unknown>> {
  const service = record(
    await runtime.request(`https://run.googleapis.com/v2/${serviceName(inputs)}`, deadline),
    'Cloud Run service'
  );
  const latest = requiredString(service.latestCreatedRevision, 'Latest created revision')
    .split('/')
    .pop();
  if (latest !== candidateRevision(inputs))
    throw new Error(`Newer Cloud Run candidate ${latest}; stopping staging promotion`);
  return service;
}
async function pause(
  runtime: PromotionRuntime,
  deadline: number,
  timeout: number,
  label: string
): Promise<void> {
  const remaining = deadline - runtime.now();
  if (remaining <= 0) throw new Error(`${label} did not complete within ${timeout / 1000} seconds`);
  await runtime.sleep(Math.min(pollIntervalMs, remaining));
}
function checkDeadline(
  runtime: PromotionRuntime,
  deadline: number,
  timeout: number,
  label: string
): void {
  if (runtime.now() >= deadline)
    throw new Error(`${label} did not complete within ${timeout / 1000} seconds`);
}

export async function promoteStaging(
  inputs: PromotionInputs,
  runtime: PromotionRuntime
): Promise<void> {
  const deadline = runtime.now() + operationTimeoutMs;
  await requireOwner(inputs, runtime, deadline);
  const service = await requireCandidate(inputs, runtime, deadline);
  const etag = requiredString(service.etag, 'Cloud Run service etag');
  const initial = record(
    await runtime.request(
      `https://run.googleapis.com/v2/${serviceName(inputs)}?updateMask=traffic`,
      deadline,
      {
        name: serviceName(inputs),
        etag,
        traffic: [
          {
            type: 'TRAFFIC_TARGET_ALLOCATION_TYPE_REVISION',
            revision: candidateRevision(inputs),
            percent: 100,
          },
        ],
      }
    ),
    'Traffic operation'
  );
  const operation = requiredString(initial.name, 'Traffic operation name');
  // The API may canonicalize the requested project ID to its numeric project number.
  const parts = operation.split('/');
  if (
    parts.length !== 6 ||
    parts[0] !== 'projects' ||
    (parts[1] !== inputs.project && !/^\d+$/.test(parts[1] ?? '')) ||
    parts[2] !== 'locations' ||
    parts[3] !== inputs.region ||
    parts[4] !== 'operations' ||
    !/^[A-Za-z0-9_-]+$/.test(parts[5] ?? '')
  ) {
    throw new Error('Cloud Run returned an unexpected operation resource');
  }
  let result = initial;
  for (;;) {
    checkDeadline(runtime, deadline, operationTimeoutMs, 'Cloud Run traffic operation');
    await requireOwner(inputs, runtime, deadline);
    await requireCandidate(inputs, runtime, deadline);
    if (result.error !== undefined) {
      const error = record(result.error, 'Operation error');
      throw new Error(
        `Cloud Run traffic operation failed: ${String(error.code)} ${String(error.message)}`
      );
    }
    if (result.done === true) {
      record(result.response, 'Completed operation response');
      runtime.log(`Cloud Run traffic operation ${operation} completed`);
      return;
    }
    if (result.done !== undefined && result.done !== false)
      throw new Error('Invalid operation completion flag');
    await pause(runtime, deadline, operationTimeoutMs, 'Cloud Run traffic operation');
    checkDeadline(runtime, deadline, operationTimeoutMs, 'Cloud Run traffic operation');
    result = record(
      await runtime.request(`https://run.googleapis.com/v2/${operation}`, deadline),
      'Traffic operation'
    );
    if (result.name !== operation) throw new Error('Cloud Run returned a different operation');
  }
}

export async function verifyStaging(
  inputs: PromotionInputs,
  runtime: PromotionRuntime
): Promise<void> {
  const deadline = runtime.now() + healthTimeoutMs;
  let observed = 'unknown';
  for (;;) {
    checkDeadline(runtime, deadline, healthTimeoutMs, 'Staging health verification');
    await requireOwner(inputs, runtime, deadline);
    await requireCandidate(inputs, runtime, deadline);
    try {
      const health = record(await runtime.health(inputs.healthUrl, deadline), 'Staging health');
      observed = typeof health.buildSha === 'string' ? health.buildSha : 'unknown';
    } catch {
      observed = 'unavailable';
    }
    checkDeadline(runtime, deadline, healthTimeoutMs, 'Staging health verification');
    if (observed === inputs.commitSha) {
      // Do not report success if a newer build took ownership during the health request.
      await requireOwner(inputs, runtime, deadline);
      await requireCandidate(inputs, runtime, deadline);
      checkDeadline(runtime, deadline, healthTimeoutMs, 'Staging health verification');
      runtime.log(`Staging is serving ${inputs.commitSha}`);
      return;
    }
    runtime.log(`Waiting for staging ${inputs.commitSha}; currently serving ${observed}`);
    await pause(runtime, deadline, healthTimeoutMs, 'Staging health verification');
  }
}
