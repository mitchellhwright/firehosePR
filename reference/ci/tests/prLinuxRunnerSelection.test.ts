import assert from 'node:assert/strict';
import test from 'node:test';

import {
  evaluateExternalHeartbeat,
  evaluateRecentExternalWork,
  combineHostedAdmission,
  evaluateHostedAdmission,
  evaluateRecentHostedWork,
  ExternalInventoryError,
  hostedOverflowPolicyEnabled,
  inspectExternalCapacity,
  inventoryFailureSuggestsSaturation,
  provenBusyFromInventory,
  recentHostedWorkFromInventory,
  finishHostedAdmission,
  readHostedProbe,
  resolveHostedAdmission,
  resolvePrLinuxRoleLabels,
  selectPrLinuxRunners,
  selectorMatchesLabels,
  type ApiRequest,
  type ExternalCapacity,
  type HostedAdmission,
  type JsonResponse,
  type WorkflowJob,
  type WorkflowRun,
} from '../src/actions/selectPrLinuxRunners.ts';
import {
  dedicatedDatabaseLinuxRunnerLabels,
  dedicatedPortableLinuxRunnerLabels,
  hostedLinuxRunnerLabels,
  sharedDatabaseLinuxRunnerLabels,
  sharedPortableLinuxRunnerLabels,
  trustedControlLinuxRunnerLabels,
} from '../src/runnerPolicy.ts';

const portable: readonly string[] = sharedPortableLinuxRunnerLabels;
const database: readonly string[] = sharedDatabaseLinuxRunnerLabels;
const explicitPortable: readonly string[] = dedicatedPortableLinuxRunnerLabels;
const explicitDatabase: readonly string[] = dedicatedDatabaseLinuxRunnerLabels;
const hosted: readonly string[] = hostedLinuxRunnerLabels;
const trustedControl: readonly string[] = trustedControlLinuxRunnerLabels;

const idleCapacity: ExternalCapacity = {
  portable: { state: 'idle', reason: 'heartbeat-fresh', runnerName: 'portable-runner' },
  database: { state: 'idle', reason: 'heartbeat-fresh', runnerName: 'database-runner' },
};
const now = Date.parse('2026-09-21T14:00:00Z');
const successfulRun: WorkflowRun = {
  id: 101,
  status: 'completed',
  conclusion: 'success',
  updated_at: '2026-09-21T13:50:00Z',
};
const successfulProbe: WorkflowJob = {
  name: 'Hosted Linux admission probe',
  status: 'completed',
  conclusion: 'success',
  runner_name: 'GitHub Actions 1000000000',
  labels: hosted,
  completed_at: '2026-09-21T13:50:00Z',
  steps: [{ name: 'Confirm hosted Linux admission', status: 'completed', conclusion: 'success' }],
};
const successfulStep = {
  name: 'Report healthy runner',
  status: 'completed',
  conclusion: 'success',
};

function heartbeatJob(
  name: string,
  labels: readonly string[],
  runnerName: string,
  completedAt = '2026-09-21T13:59:00Z',
): WorkflowJob {
  return {
    name,
    status: 'completed',
    conclusion: 'success',
    runner_name: runnerName,
    labels,
    started_at: completedAt,
    completed_at: completedAt,
    steps: [successfulStep],
  };
}

const alignedHeartbeatJobs = [
  heartbeatJob('External Linux heartbeat (portable)', portable, 'portable-runner'),
  heartbeatJob('External Linux heartbeat (database)', database, 'database-runner'),
];

function jsonResponse(payload: unknown): JsonResponse {
  return { ok: true, status: 200, json: async () => payload };
}

interface CapacityFixture {
  readonly queuedRuns?: readonly WorkflowRun[];
  readonly inProgressRuns?: readonly WorkflowRun[];
  readonly activeJobs?: Readonly<Record<string, readonly WorkflowJob[]>>;
  readonly heartbeatRuns?: readonly WorkflowRun[];
  readonly heartbeatJobs?: Readonly<Record<string, readonly WorkflowJob[]>>;
  readonly recentWorkRuns?: readonly WorkflowRun[];
  readonly recentWorkJobs?: Readonly<Record<string, readonly WorkflowJob[]>>;
}

function capacityRequest({
  queuedRuns = [],
  inProgressRuns = [],
  activeJobs = {},
  heartbeatRuns = [{
    id: 202,
    status: 'completed',
    conclusion: 'success',
    event: 'schedule',
    created_at: '2026-09-21T13:58:00Z',
    updated_at: '2026-09-21T13:59:00Z',
    head_branch: 'develop',
  }],
  heartbeatJobs = { 202: alignedHeartbeatJobs },
  recentWorkRuns = [],
  recentWorkJobs = {},
}: CapacityFixture = {}): ApiRequest {
  return async (url: string) => {
    if (url.includes('/actions/runs?status=queued')) {
      return jsonResponse({ workflow_runs: queuedRuns });
    }
    if (url.includes('/actions/runs?status=in_progress')) {
      return jsonResponse({ workflow_runs: inProgressRuns });
    }
    if (url.includes('/actions/workflows/linux-runner-heartbeat.yml/runs?status=completed')) {
      return jsonResponse({ workflow_runs: heartbeatRuns });
    }
    if (url.includes('/actions/workflows/pr-checks.yml/runs?status=completed')) {
      return jsonResponse({ workflow_runs: recentWorkRuns });
    }
    const runId = /\/actions\/runs\/(\d+)\/jobs/.exec(url)?.[1];
    if (runId !== undefined && Object.hasOwn(activeJobs, runId)) {
      return jsonResponse({ jobs: activeJobs[runId] });
    }
    if (runId !== undefined && Object.hasOwn(heartbeatJobs, runId)) {
      return jsonResponse({ jobs: heartbeatJobs[runId] });
    }
    if (runId !== undefined && Object.hasOwn(recentWorkJobs, runId)) {
      return jsonResponse({ jobs: recentWorkJobs[runId] });
    }
    throw new Error(`Unexpected request: ${url}`);
  };
}

async function inspectWith(request: ApiRequest, databaseRequired = true) {
  return inspectExternalCapacity({
    apiUrl: 'https://api.github.test',
    repository: 'example-org/example-app',
    token: 'test-token',
    checkLabels: portable,
    databaseLabels: database,
    request,
    now,
    databaseRequired,
  });
}

async function inspectWithCurrentRun(request: ApiRequest, runId: string) {
  return inspectExternalCapacity({
    apiUrl: 'https://api.github.test',
    repository: 'example-org/example-app',
    token: 'test-token',
    checkLabels: portable,
    databaseLabels: database,
    request,
    now,
    excludeRunId: runId,
  });
}

test('fresh completed hosted work is positive admission evidence', () => {
  assert.deepEqual(evaluateHostedAdmission({
    run: successfulRun,
    jobs: [successfulProbe],
    now,
  }), { available: true, reason: 'hosted-probe-fresh' });
});

test('the hosted policy variable is a fail-closed gate, not admission evidence', () => {
  assert.equal(hostedOverflowPolicyEnabled('1'), true);
  for (const value of ['0', '', 'true', 'yes', undefined]) {
    assert.equal(hostedOverflowPolicyEnabled(value), false);
  }
  assert.deepEqual(evaluateHostedAdmission({
    run: successfulRun,
    jobs: [successfulProbe],
    now,
  }), { available: true, reason: 'hosted-probe-fresh' });

  const admission = evaluateHostedAdmission({
    run: successfulRun,
    jobs: [successfulProbe],
    now,
  });
  const busyCapacity: ExternalCapacity = {
    portable: { state: 'busy', reason: 'active-portable-work' },
    database: { state: 'busy', reason: 'active-database-work' },
  };
  const routeWithPolicy = (policy: string) => selectPrLinuxRunners({
    sameRepository: true,
    checkLabels: portable,
    databaseLabels: database,
    hostedAvailable: hostedOverflowPolicyEnabled(policy) && admission.available,
    externalCapacity: busyCapacity,
  });
  assert.deepEqual(routeWithPolicy('0'), {
    checks: portable,
    database,
    overflow: portable,
    reason: 'hosted-admission-unavailable',
  });
  assert.deepEqual(routeWithPolicy('1'), {
    checks: hosted,
    database: hosted,
    overflow: hosted,
    reason: 'external-busy-hosted-overflow',
  });
});

test('incomplete, failed, runnerless, label-mismatched, and stale hosted probes fail closed', () => {
  const cases = [
    {
      run: { ...successfulRun, status: 'queued', conclusion: null },
      jobs: [],
      reason: 'hosted-probe-incomplete',
    },
    {
      run: { ...successfulRun, conclusion: 'failure' },
      jobs: [],
      reason: 'hosted-probe-failed',
    },
    {
      run: successfulRun,
      jobs: [{ ...successfulProbe, runner_name: '' }],
      reason: 'hosted-probe-runnerless',
    },
    {
      run: successfulRun,
      jobs: [{ ...successfulProbe, labels: ['ubuntu-24.04', 'self-hosted'] }],
      reason: 'hosted-probe-label-mismatch',
    },
    {
      run: successfulRun,
      jobs: [{ ...successfulProbe, completed_at: '2026-09-21T12:50:00Z' }],
      reason: 'hosted-probe-stale',
    },
  ];
  for (const entry of cases) {
    assert.deepEqual(evaluateHostedAdmission({
      run: entry.run,
      jobs: entry.jobs,
      now,
    }), { available: false, reason: entry.reason });
  }
  assert.deepEqual(evaluateHostedAdmission({ jobs: [], now }), {
    available: false,
    reason: 'hosted-probe-missing',
  });
});

function hostedWorkJob(overrides: Partial<WorkflowJob> = {}): WorkflowJob {
  return {
    name: 'Workflow contracts',
    status: 'completed',
    conclusion: 'success',
    runner_name: 'GitHub Actions 1000000123',
    labels: hosted,
    started_at: '2026-09-21T13:55:00Z',
    completed_at: '2026-09-21T13:58:00Z',
    steps: [successfulStep],
    ...overrides,
  };
}

const freshHostedWork: HostedAdmission = { available: true, reason: 'hosted-recent-work-fresh',
  admittedAt: Date.parse('2026-09-21T13:55:00Z') };

interface ProbeFixture {
  readonly runs: readonly WorkflowRun[];
  readonly jobs?: Readonly<Record<string, readonly WorkflowJob[]>>;
  readonly dispatchStatus?: number;
}

function probeRequest({ runs, jobs = {}, dispatchStatus = 204 }: ProbeFixture): {
  readonly request: ApiRequest;
  readonly dispatched: RequestInit[];
} {
  const dispatched: RequestInit[] = [];
  const request: ApiRequest = async (url, init) => {
    if (url.endsWith('/dispatches')) {
      assert.ok(init);
      dispatched.push(init);
      return { ok: dispatchStatus < 300, status: dispatchStatus, json: async () => undefined };
    }
    if (url.includes('/actions/workflows/hosted-linux-admission.yml/runs')) {
      return jsonResponse({ workflow_runs: runs });
    }
    const runId = /\/actions\/runs\/(\d+)\/jobs/.exec(url)?.[1];
    if (runId !== undefined && Object.hasOwn(jobs, runId)) return jsonResponse({ jobs: jobs[runId] });
    throw new Error(`Unexpected request ${url}`);
  };
  return { request, dispatched };
}

async function resolveWith(
  fixture: ProbeFixture,
  options: { readonly recentWork?: HostedAdmission; readonly requestRefresh?: boolean } = {},
) {
  const { request, dispatched } = probeRequest(fixture);
  const admission = await resolveHostedAdmission({
    apiUrl: 'https://api.github.test', repository: 'example-org/example-app',
    defaultBranch: 'develop', token: 'test-token', request, now,
    requestRefresh: options.requestRefresh ?? true,
    ...(options.recentWork === undefined ? {} : { recentWork: options.recentWork }),
  });
  return { admission, dispatched };
}

const staleProbeFixture: ProbeFixture = {
  runs: [successfulRun],
  jobs: { 101: [{ ...successfulProbe, completed_at: '2026-09-21T12:50:00Z' }] },
};

test('a fresh probe admits hosted overflow without dispatching another', async () => {
  const { admission, dispatched } = await resolveWith({
    runs: [successfulRun],
    jobs: { 101: [successfulProbe] },
  });
  assert.equal(admission.available, true);
  assert.equal(admission.reason, 'hosted-probe-fresh');
  assert.equal(dispatched.length, 0);
});

test('fresh successful hosted work admits overflow when the latest probe is stale', async () => {
  const { admission, dispatched } = await resolveWith(staleProbeFixture, {
    recentWork: freshHostedWork,
  });
  assert.deepEqual(admission, freshHostedWork);
  assert.equal(dispatched.length, 0);
});

test('a stale probe without hosted work requests one probe without waiting and fails closed', async () => {
  const { admission, dispatched } = await resolveWith(staleProbeFixture, {
    recentWork: { available: false, reason: 'hosted-recent-work-missing' },
  });
  assert.deepEqual(admission, { available: false, reason: 'hosted-probe-refresh-requested' });
  assert.equal(dispatched.length, 1);
  assert.equal(dispatched[0]?.method, 'POST');
  assert.deepEqual(JSON.parse(String(dispatched[0]?.body)), { ref: 'develop' });
});

test('a newly dispatched hosted probe can admit the same waiting PR planner', async () => {
  let reads = 0;
  let dispatches = 0;
  const request: ApiRequest = async (url) => {
    if (url.endsWith('/dispatches')) {
      dispatches += 1;
      return { ok: true, status: 204, json: async () => undefined };
    }
    if (url.includes('/actions/workflows/hosted-linux-admission.yml/runs')) {
      reads += 1;
      return jsonResponse({ workflow_runs: reads === 1
        ? [successfulRun]
        : [{ ...successfulRun, id: 102, updated_at: '2026-09-21T14:00:01Z',
          status: reads === 2 ? 'in_progress' : 'completed',
          conclusion: reads === 2 ? null : 'success' }, successfulRun] });
    }
    if (url.includes('/actions/runs/101/jobs')) {
      return jsonResponse({ jobs: staleProbeFixture.jobs?.[101] });
    }
    if (url.includes('/actions/runs/102/jobs')) {
      return jsonResponse({ jobs: [successfulProbe] });
    }
    throw new Error(`Unexpected request ${url}`);
  };
  const probe = await readHostedProbe({ apiUrl: 'https://api.github.test',
    repository: 'example-org/example-app', defaultBranch: 'develop', token: 'test-token',
    request, now });
  const delays: number[] = [];
  const admission = await finishHostedAdmission({
    apiUrl: 'https://api.github.test', repository: 'example-org/example-app',
    defaultBranch: 'develop', token: 'test-token',
    probe,
    requestRefresh: true, waitForDispatchedProbe: true,
    pollDelay: async milliseconds => { delays.push(milliseconds); },
    pollNow: () => now + 2_000,
    request, now,
  });
  assert.deepEqual(admission, { available: true, reason: 'hosted-probe-fresh' });
  assert.equal(dispatches, 1);
  assert.deepEqual(delays, [2_000, 2_000]);
});

test('a dispatched probe that does not complete within the bounded wait fails closed', async () => {
  let reads = 0;
  let dispatches = 0;
  const request: ApiRequest = async (url) => {
    if (url.endsWith('/dispatches')) {
      dispatches += 1;
      return { ok: true, status: 204, json: async () => undefined };
    }
    if (url.includes('/actions/workflows/hosted-linux-admission.yml/runs')) {
      reads += 1;
      return jsonResponse({ workflow_runs: reads === 1
        ? [successfulRun]
        : [{ ...successfulRun, id: 102, status: 'in_progress', conclusion: null }, successfulRun] });
    }
    if (url.includes('/actions/runs/101/jobs')) {
      return jsonResponse({ jobs: staleProbeFixture.jobs?.[101] });
    }
    throw new Error(`Unexpected request ${url}`);
  };
  const probe = await readHostedProbe({ apiUrl: 'https://api.github.test',
    repository: 'example-org/example-app', defaultBranch: 'develop', token: 'test-token',
    request, now });
  let delays = 0;
  const admission = await finishHostedAdmission({
    apiUrl: 'https://api.github.test', repository: 'example-org/example-app',
    defaultBranch: 'develop', token: 'test-token',
    probe,
    requestRefresh: true, waitForDispatchedProbe: true,
    pollDelay: async () => { delays += 1; },
    request, now,
  });
  assert.deepEqual(admission, { available: false, reason: 'hosted-probe-refresh-requested' });
  assert.equal(dispatches, 1);
  assert.equal(delays, 6);
});

test('a caller with no planned overflow reads hosted evidence without requesting a probe', async () => {
  const { admission, dispatched } = await resolveWith(staleProbeFixture, {
    requestRefresh: false,
  });
  assert.deepEqual(admission, { available: false, reason: 'hosted-probe-stale' });
  assert.equal(dispatched.length, 0);
});

test('a rejected probe dispatch is reported explicitly', async () => {
  const { admission } = await resolveWith({ ...staleProbeFixture, dispatchStatus: 403 });
  assert.deepEqual(admission, { available: false, reason: 'hosted-probe-dispatch-http-403' });
});

test('a queued probe hides neither older fresh evidence nor causes a duplicate dispatch', async () => {
  const queued: WorkflowRun = { id: 102, status: 'queued', conclusion: null };
  const fresh = await resolveWith({ runs: [queued, successfulRun], jobs: { 101: [successfulProbe] } });
  assert.equal(fresh.admission.reason, 'hosted-probe-fresh');
  const stale = await resolveWith({ ...staleProbeFixture, runs: [queued, successfulRun] });
  assert.deepEqual(stale.admission, { available: false, reason: 'hosted-probe-stale' });
  assert.equal(stale.dispatched.length, 0);
  const onlyQueued = await resolveWith({ runs: [queued] });
  assert.deepEqual(onlyQueued.admission, { available: false, reason: 'hosted-probe-incomplete' });
  assert.equal(onlyQueued.dispatched.length, 0);
});

test('a canceled pending probe is not mistaken for hosted billing rejection', async () => {
  const { admission } = await resolveWith({
    runs: [{ ...successfulRun, id: 102, conclusion: 'cancelled' }, successfulRun],
    jobs: { 101: [successfulProbe] },
  });
  assert.equal(admission.reason, 'hosted-probe-fresh');
});

test('a failed hosted probe remains a billing signal and is not dispatched repeatedly', async () => {
  const failedRun = { ...successfulRun, conclusion: 'failure', updated_at: '2026-09-21T13:56:00Z' };
  const { admission, dispatched } = await resolveWith({ runs: [failedRun] }, {
    recentWork: freshHostedWork,
  });
  assert.deepEqual(admission, { available: false, reason: 'hosted-probe-failed' });
  assert.equal(dispatched.length, 0);
});

test('hosted work that succeeded after a failed probe is newer admission evidence', async () => {
  const failedRun = { ...successfulRun, conclusion: 'failure', updated_at: '2026-09-21T13:50:00Z' };
  const { admission } = await resolveWith({ runs: [failedRun] }, { recentWork: freshHostedWork });
  assert.deepEqual(admission, freshHostedWork);
});

test('a long hosted job allocated before a failed probe does not reopen overflow', async () => {
  const failedRun = { ...successfulRun, conclusion: 'failure', updated_at: '2026-09-21T13:50:00Z' };
  const longJob = hostedWorkJob({
    started_at: '2026-09-21T13:30:00Z',
    completed_at: '2026-09-21T13:59:00Z',
  });
  const recentWork = evaluateRecentHostedWork({ jobs: [longJob], now });
  assert.equal(recentWork.available, true);
  const { admission } = await resolveWith({ runs: [failedRun] }, { recentWork });
  assert.deepEqual(admission, { available: false, reason: 'hosted-probe-failed' });
});

test('an old billing failure is rechecked once when external Linux is saturated', async () => {
  const failedRun = { ...successfulRun, conclusion: 'failure', updated_at: '2026-09-21T13:30:00Z' };
  const { admission, dispatched } = await resolveWith({ runs: [failedRun] });
  assert.deepEqual(admission, { available: false, reason: 'hosted-probe-refresh-requested' });
  assert.equal(dispatched.length, 1);
});

test('only recent successful work on the exact hosted route is admission evidence', () => {
  assert.deepEqual(evaluateRecentHostedWork({ jobs: [hostedWorkJob()], now }), freshHostedWork);
  const refused: readonly [WorkflowJob, string][] = [
    [hostedWorkJob({ started_at: '2026-09-21T12:50:00Z' }), 'hosted-recent-work-stale'],
    [hostedWorkJob({ conclusion: 'failure' }), 'hosted-recent-work-missing'],
    [hostedWorkJob({ status: 'in_progress', conclusion: null }), 'hosted-recent-work-missing'],
    [hostedWorkJob({ runner_name: '' }), 'hosted-recent-work-missing'],
    [hostedWorkJob({ steps: [] }), 'hosted-recent-work-missing'],
    [hostedWorkJob({ started_at: null }), 'hosted-recent-work-missing'],
    [hostedWorkJob({ labels: portable }), 'hosted-recent-work-missing'],
    [hostedWorkJob({ labels: [...hosted, 'self-hosted'] }), 'hosted-recent-work-missing'],
  ];
  for (const [job, reason] of refused) {
    assert.deepEqual(evaluateRecentHostedWork({ jobs: [job], now }), { available: false, reason });
  }
  assert.deepEqual(evaluateRecentHostedWork({ jobs: [], now }), {
    available: false,
    reason: 'hosted-recent-work-missing',
  });
});

test('external inventory reports recent hosted pr-checks work alongside lane capacity', async () => {
  const inventory = await inspectWith(capacityRequest({
    recentWorkRuns: [{ id: 303, status: 'completed', conclusion: 'success' }],
    recentWorkJobs: { 303: [hostedWorkJob(), hostedWorkJob({
      name: 'Lint changed code', started_at: '2026-09-21T13:40:00Z',
    })] },
  }));
  assert.deepEqual(inventory.recentHostedWork, freshHostedWork);
  const stale = await inspectWith(capacityRequest({
    recentWorkRuns: [{ id: 303, status: 'completed', conclusion: 'success' }],
    recentWorkJobs: { 303: [hostedWorkJob({ started_at: '2026-09-21T12:50:00Z' })] },
  }));
  assert.deepEqual(stale.recentHostedWork, {
    available: false,
    reason: 'hosted-recent-work-stale',
  });
});

test('recent hosted work never changes the fork route', () => {
  const combined = combineHostedAdmission({
    probe: { available: false, reason: 'hosted-probe-stale' },
    recentWork: freshHostedWork,
  });
  for (const hostedAvailable of [combined.available, false]) {
    const selection = selectPrLinuxRunners({
      sameRepository: false,
      checkLabels: portable,
      databaseLabels: database,
      hostedAvailable,
      externalCapacity: idleCapacity,
    });
    assert.deepEqual([selection.checks, selection.database, selection.overflow],
      [hosted, hosted, hosted]);
    assert.equal(selection.reason,
      hostedAvailable ? 'fork-hosted-only' : 'fork-hosted-unavailable');
  }
});

test('default database route has a positive lane identity that live trusted control lacks', () => {
  const resolved = resolvePrLinuxRoleLabels({});
  assert.equal(resolved.usedFallback, true);
  assert.equal(resolved.reason, 'portable-selector-invalid');
  assert.deepEqual(resolved.checks, portable);
  assert.deepEqual(resolved.database, database);

  // Read-only organization inventory on 2026-09-21 proved this exact listener
  // handled an unsafe database selector before example-lane became mandatory.
  const liveTrustedControl = [
    'self-hosted',
    'ARM64',
    'Linux',
    'linux-remote',
    'host-instaip2',
    'example-trusted-control',
    'docker-capable',
  ];
  assert.equal(selectorMatchesLabels(liveTrustedControl, database), false);
  assert.ok(database.includes('example-lane'));
});

test('explicit portable and database role labels are retained without architecture fallback', () => {
  assert.deepEqual(resolvePrLinuxRoleLabels({
    checkLabels: explicitPortable,
    databaseLabels: explicitDatabase,
  }), {
    checks: explicitPortable,
    database: explicitDatabase,
    usedFallback: false,
    reason: 'explicit-role-selectors',
  });
  assert.ok(!explicitPortable.includes('X64'));
  assert.ok(!explicitDatabase.includes('ARM64'));
});

test('shared portable labels let every worker lane run architecture-neutral checks', () => {
  assert.deepEqual(resolvePrLinuxRoleLabels({
    checkLabels: portable,
    databaseLabels: database,
  }), {
    checks: portable,
    database,
    usedFallback: false,
    reason: 'shared-portable-lane',
  });
  assert.ok(!portable.includes('X64'));
  assert.ok(!portable.includes('ARM64'));
  assert.ok(!portable.includes('docker-capable'));
});

test('mixed and capability-specific portable selectors fall back to the shared lane', () => {
  const cases = [
    {
      checkLabels: explicitPortable,
      databaseLabels: database,
      reason: 'role-selectors-not-compatible',
    },
    {
      checkLabels: [...portable, 'ARM64'],
      databaseLabels: database,
      reason: 'portable-selector-invalid',
    },
    {
      checkLabels: portable,
      databaseLabels: [...database, 'example-trusted-control'],
      reason: 'database-selector-invalid',
    },
    {
      checkLabels: [...portable, 'nonexistent-worker-label'],
      databaseLabels: database,
      reason: 'portable-selector-invalid',
    },
  ];
  for (const candidate of cases) {
    const resolved = resolvePrLinuxRoleLabels(candidate);
    assert.deepEqual(resolved.checks, portable);
    assert.deepEqual(resolved.database, database);
    assert.equal(resolved.usedFallback, true);
    assert.equal(resolved.reason, candidate.reason);
  }
});

test('idle external roles remain preferred while admitted overflow keeps bounded fan-out', () => {
  assert.deepEqual(selectPrLinuxRunners({
    sameRepository: true,
    checkLabels: portable,
    databaseLabels: database,
    hostedAvailable: true,
    externalCapacity: idleCapacity,
  }), {
    checks: portable,
    database,
    overflow: hosted,
    reason: 'external-capacity-preferred',
  });
});

test('positive busy evidence enables hosted overflow only for the busy role', () => {
  assert.deepEqual(selectPrLinuxRunners({
    sameRepository: true,
    checkLabels: portable,
    databaseLabels: database,
    hostedAvailable: true,
    externalCapacity: {
      portable: { state: 'busy', reason: 'active-portable-work' },
      database: idleCapacity.database,
    },
  }), {
    checks: hosted,
    database,
    overflow: hosted,
    reason: 'external-busy-hosted-overflow',
  });
});

test('unknown heartbeat keeps every portable job external despite fresh hosted admission', () => {
  const unknownCapacity: ExternalCapacity = {
    portable: { state: 'unknown', reason: 'heartbeat-stale' },
    database: { state: 'unknown', reason: 'heartbeat-missing' },
  };
  assert.deepEqual(selectPrLinuxRunners({
    sameRepository: true,
    checkLabels: portable,
    databaseLabels: database,
    hostedAvailable: true,
    externalCapacity: unknownCapacity,
  }), {
    checks: portable,
    database,
    overflow: portable,
    reason: 'external-heartbeat-unknown',
  });
});

test('unavailable hosted admission queues busy work on the isolated external routes', () => {
  assert.deepEqual(selectPrLinuxRunners({
    sameRepository: true,
    checkLabels: portable,
    databaseLabels: database,
    hostedAvailable: false,
    externalCapacity: {
      portable: { state: 'busy', reason: 'active-portable-work' },
      database: { state: 'busy', reason: 'active-database-work' },
    },
  }), {
    checks: portable,
    database,
    overflow: portable,
    reason: 'hosted-admission-unavailable',
  });
});

test('incomplete external inventory does not spend hosted capacity', () => {
  assert.deepEqual(selectPrLinuxRunners({
    sameRepository: true,
    checkLabels: portable,
    databaseLabels: database,
    hostedAvailable: true,
    externalInventoryAvailable: false,
  }), {
    checks: portable,
    database,
    overflow: portable,
    reason: 'external-inventory-unavailable',
  });
});

test('forks never receive persistent external runners', () => {
  for (const hostedAvailable of [true, false]) {
    const selection = selectPrLinuxRunners({
      sameRepository: false,
      checkLabels: portable,
      databaseLabels: database,
      hostedAvailable,
      externalCapacity: idleCapacity,
    });
    assert.deepEqual(selection.checks, hosted);
    assert.deepEqual(selection.database, hosted);
    assert.deepEqual(selection.overflow, hosted);
    assert.equal(selection.reason, hostedAvailable ? 'fork-hosted-only' : 'fork-hosted-unavailable');
  }
});

test('heartbeat evaluation diagnoses stale and selector-mismatched cron evidence', () => {
  assert.deepEqual(evaluateExternalHeartbeat({
    jobs: [heartbeatJob(
      'External Linux heartbeat (portable)',
      portable,
      'portable-runner',
      '2026-09-21T13:30:00Z',
    )],
    jobName: 'External Linux heartbeat (portable)',
    expectedLabels: portable,
    now,
  }), {
    state: 'unknown',
    reason: 'heartbeat-stale',
    runnerName: undefined,
  });
  assert.deepEqual(evaluateExternalHeartbeat({
    jobs: [heartbeatJob(
      'External Linux heartbeat (portable)',
      ['self-hosted', 'Linux', 'example-lane'],
      'database-runner',
    )],
    jobName: 'External Linux heartbeat (portable)',
    expectedLabels: portable,
    now,
  }), {
    state: 'unknown',
    reason: 'heartbeat-selector-mismatch',
    runnerName: undefined,
  });
});

test('recent real work proves capacity when GitHub delays scheduled heartbeats', async () => {
  const recentJob = (name: string, labels: readonly string[], runnerName: string): WorkflowJob => ({
    name,
    status: 'completed',
    conclusion: 'success',
    runner_name: runnerName,
    labels,
    completed_at: '2026-09-21T13:59:00Z',
    steps: [successfulStep],
  });
  const inventory = await inspectWith(capacityRequest({
    heartbeatJobs: {
      202: [
        heartbeatJob('External Linux heartbeat (portable)', portable, 'portable-runner',
          '2026-09-21T13:30:00Z'),
        heartbeatJob('External Linux heartbeat (database)', database, 'database-runner',
          '2026-09-21T13:30:00Z'),
      ],
    },
    recentWorkRuns: [{ id: 303, status: 'completed', conclusion: 'success' }],
    recentWorkJobs: {
      303: [
        recentJob('Workflow contracts', portable, 'portable-runner'),
        recentJob('Run database integration tests', database, 'database-runner'),
      ],
    },
  }));
  assert.deepEqual(inventory.roles, {
    portable: { state: 'idle', reason: 'recent-work-fresh', runnerName: 'portable-runner' },
    database: { state: 'idle', reason: 'recent-work-fresh', runnerName: 'database-runner' },
  });
  assert.deepEqual(selectPrLinuxRunners({
    sameRepository: true,
    checkLabels: portable,
    databaseLabels: database,
    hostedAvailable: true,
    externalCapacity: inventory.roles,
  }).overflow, hosted);
  assert.deepEqual(evaluateRecentExternalWork({
    jobs: [recentJob('Workflow contracts', portable, 'portable-runner')],
    expectedLabels: database,
    now,
  }), { state: 'unknown', reason: 'recent-work-missing' });
  assert.deepEqual(evaluateRecentExternalWork({
    jobs: [{ ...recentJob('Workflow contracts', portable, 'portable-runner'),
      completed_at: '2026-09-21T13:30:00Z' }],
    expectedLabels: portable,
    now,
  }), { state: 'unknown', reason: 'recent-work-stale' });
});

test('completed jobs in an active run identify a busy listener when heartbeats are stale', async () => {
  const inventory = await inspectWith(capacityRequest({
    queuedRuns: [{ id: 201, status: 'queued' }],
    activeJobs: {
      201: [
        heartbeatJob('Server tests (1/4)', portable, 'shared-runner'),
        heartbeatJob('Run database integration tests', database, 'shared-runner'),
        {
          name: 'Plan PR validation',
          status: 'in_progress',
          runner_name: 'shared-runner',
          labels: trustedControl,
        },
      ],
    },
    heartbeatJobs: {
      202: [
        heartbeatJob('External Linux heartbeat (portable)', portable, 'shared-runner',
          '2026-09-21T13:30:00Z'),
        heartbeatJob('External Linux heartbeat (database)', database, 'shared-runner',
          '2026-09-21T13:30:00Z'),
      ],
    },
  }));
  assert.deepEqual(inventory.roles, {
    portable: { state: 'busy', reason: 'shared-runner-other-work', runnerName: undefined },
    database: { state: 'busy', reason: 'shared-runner-other-work', runnerName: undefined },
  });
  const selection = selectPrLinuxRunners({
    sameRepository: true,
    checkLabels: portable,
    databaseLabels: database,
    hostedAvailable: true,
    externalCapacity: inventory.roles,
  });
  assert.deepEqual(selection.checks, hosted);
  assert.deepEqual(selection.database, hosted);
});

test('workflow-jobs labels are treated as requested selectors, not inferred runner labels', async () => {
  // Exact fields observed in run 35605139595. The broad portable request ran
  // on the ARM64 lane and the unsafe database request ran on trusted control,
  // proving that job.labels cannot be copied into a runner inventory.
  const observedJobs = [
    {
      id: 106350275560,
      name: 'External Linux heartbeat (portable)',
      status: 'completed',
      conclusion: 'success',
      runner_name: 'instaip2-example-lanes',
      labels: ['self-hosted', 'Linux', 'example-lane'],
      started_at: '2026-09-21T13:25:46Z',
      completed_at: '2026-09-21T13:25:49Z',
      steps: [successfulStep],
    },
    {
      id: 106350275837,
      name: 'External Linux heartbeat (database)',
      status: 'completed',
      conclusion: 'success',
      runner_name: 'instaip-example-trusted-control',
      labels: ['self-hosted', 'Linux', 'ARM64', 'docker-capable', 'linux-remote'],
      started_at: '2026-09-21T13:21:59Z',
      completed_at: '2026-09-21T13:22:01Z',
      steps: [successfulStep],
    },
  ];
  const inventory = await inspectWith(capacityRequest({
    heartbeatRuns: [{
      id: 35605139595,
      status: 'completed',
      conclusion: 'success',
      event: 'schedule',
      created_at: '2026-09-21T13:21:57Z',
      updated_at: '2026-09-21T13:25:50Z',
      head_branch: 'develop',
    }],
    heartbeatJobs: { 35605139595: observedJobs },
  }));
  assert.deepEqual(inventory.roles, {
    portable: {
      state: 'unknown',
      reason: 'heartbeat-selector-mismatch',
      runnerName: undefined,
    },
    database: {
      state: 'unknown',
      reason: 'heartbeat-selector-mismatch',
      runnerName: undefined,
    },
  });
  assert.equal(Object.hasOwn(inventory, 'runners'), false);
});

test('trusted-control jobs do not reserve either lane role', async () => {
  const inventory = await inspectWith(capacityRequest({
    inProgressRuns: [{ id: 201, status: 'in_progress' }],
    activeJobs: {
      201: [{
        name: 'Plan PR validation',
        status: 'queued',
        conclusion: null,
        runner_name: '',
        labels: ['self-hosted', 'Linux', 'example-trusted-control'],
        started_at: '2026-09-21T13:59:00Z',
        completed_at: null,
      }],
    },
  }));
  assert.equal(inventory.hasQueuedPortableWork, false);
  assert.equal(inventory.hasQueuedDatabaseWork, false);
  assert.deepEqual(inventory.roles, idleCapacity);
});

test('a competing planner on trusted control does not consume either lane role', async () => {
  const inventory = await inspectWith(capacityRequest({
    queuedRuns: [{ id: 201, status: 'queued' }],
    activeJobs: {
      201: [{
        name: 'Plan PR validation',
        status: 'queued',
        conclusion: null,
        runner_name: '',
        labels: ['self-hosted', 'Linux', 'example-trusted-control'],
        started_at: null,
        completed_at: null,
      }],
    },
  }));
  assert.equal(inventory.hasQueuedPortableWork, false);
  assert.equal(inventory.hasQueuedDatabaseWork, false);
  assert.deepEqual(inventory.roles, idleCapacity);
});

test('the live-proven unsafe database job is not mistaken for lane availability or demand', async () => {
  const inventory = await inspectWith(capacityRequest({
    inProgressRuns: [{ id: 201, status: 'in_progress' }],
    activeJobs: {
      201: [{
        name: 'Run database integration tests',
        status: 'in_progress',
        conclusion: null,
        runner_name: 'instaip-example-trusted-control',
        labels: ['self-hosted', 'Linux', 'ARM64', 'docker-capable', 'linux-remote'],
        started_at: '2026-09-21T13:59:00Z',
        completed_at: null,
      }],
    },
  }));
  assert.equal(inventory.hasQueuedPortableWork, false);
  assert.equal(inventory.hasQueuedDatabaseWork, false);
  assert.deepEqual(inventory.roles, idleCapacity);
});

test('queued capacity is reserved only for its positive role selector', async () => {
  const inventory = await inspectWith(capacityRequest({
    queuedRuns: [{ id: 201, status: 'queued' }],
    activeJobs: {
      201: [{
        name: 'Lint changed code',
        status: 'queued',
        conclusion: null,
        runner_name: '',
        labels: portable,
        started_at: '2026-09-21T13:59:00Z',
        completed_at: null,
      }],
    },
  }));
  assert.equal(inventory.hasQueuedPortableWork, true);
  assert.equal(inventory.hasQueuedDatabaseWork, false);
  assert.deepEqual(inventory.roles, {
    portable: { state: 'busy', reason: 'active-portable-work', runnerName: undefined },
    database: idleCapacity.database,
  });
});

test('legacy broad example-lane jobs conservatively reserve both roles', async () => {
  const inventory = await inspectWith(capacityRequest({
    queuedRuns: [{ id: 201, status: 'queued' }],
    activeJobs: {
      201: [{
        name: 'Server tests (1/4)',
        status: 'queued',
        conclusion: null,
        runner_name: '',
        labels: ['self-hosted', 'Linux', 'example-lane'],
        started_at: '2026-09-21T13:59:00Z',
        completed_at: null,
      }],
    },
  }));
  assert.equal(inventory.hasQueuedPortableWork, true);
  assert.equal(inventory.hasQueuedDatabaseWork, true);
  assert.equal(inventory.roles.portable.state, 'busy');
  assert.equal(inventory.roles.database.state, 'busy');
});

test('one shared-capability runner may complete both aligned heartbeats', async () => {
  const sharedRunnerJobs = [
    heartbeatJob('External Linux heartbeat (portable)', portable, 'shared-runner'),
    heartbeatJob('External Linux heartbeat (database)', database, 'shared-runner'),
  ];
  const inventory = await inspectWith(capacityRequest({
    heartbeatJobs: { 202: sharedRunnerJobs },
  }));
  assert.deepEqual(inventory.roles, {
    portable: { state: 'idle', reason: 'heartbeat-fresh', runnerName: 'shared-runner' },
    database: { state: 'idle', reason: 'heartbeat-fresh', runnerName: 'shared-runner' },
  });
});

test('in-progress work reserves every role exposed by its shared runner', async () => {
  const sharedRunnerJobs = [
    heartbeatJob('External Linux heartbeat (portable)', portable, 'shared-runner'),
    heartbeatJob('External Linux heartbeat (database)', database, 'shared-runner'),
  ];
  const portableWork = await inspectWith(capacityRequest({
    inProgressRuns: [{ id: 201, status: 'in_progress' }],
    activeJobs: {
      201: [{
        name: 'Server tests (1/4)',
        status: 'in_progress',
        conclusion: null,
        runner_name: 'shared-runner',
        labels: portable,
        started_at: '2026-09-21T13:59:00Z',
        completed_at: null,
      }],
    },
    heartbeatJobs: { 202: sharedRunnerJobs },
  }));
  assert.equal(portableWork.hasQueuedPortableWork, true);
  assert.equal(portableWork.hasQueuedDatabaseWork, true);
  assert.deepEqual(portableWork.roles, {
    portable: { state: 'busy', reason: 'active-portable-work', runnerName: undefined },
    database: { state: 'busy', reason: 'shared-runner-portable-work', runnerName: undefined },
  });

  const databaseWork = await inspectWith(capacityRequest({
    inProgressRuns: [{ id: 201, status: 'in_progress' }],
    activeJobs: {
      201: [{
        name: 'Run database integration tests',
        status: 'in_progress',
        conclusion: null,
        runner_name: 'shared-runner',
        labels: database,
        started_at: '2026-09-21T13:59:00Z',
        completed_at: null,
      }],
    },
    heartbeatJobs: { 202: sharedRunnerJobs },
  }));
  assert.equal(databaseWork.hasQueuedPortableWork, true);
  assert.equal(databaseWork.hasQueuedDatabaseWork, true);
  assert.deepEqual(databaseWork.roles, {
    portable: { state: 'busy', reason: 'active-portable-work', runnerName: undefined },
    database: { state: 'busy', reason: 'active-database-work', runnerName: undefined },
  });
});

test('trusted control work reserves worker roles exposed by the same listener', async () => {
  const sharedRunnerJobs = [
    heartbeatJob('External Linux heartbeat (portable)', portable, 'shared-runner'),
    heartbeatJob('External Linux heartbeat (database)', database, 'shared-runner'),
  ];
  const inventory = await inspectWith(capacityRequest({
    inProgressRuns: [{ id: 201, status: 'in_progress' }],
    activeJobs: {
      201: [{
        name: 'Plan PR validation',
        status: 'in_progress',
        conclusion: null,
        runner_name: 'shared-runner',
        labels: ['self-hosted', 'Linux', 'example-trusted-control'],
        started_at: '2026-09-21T13:59:00Z',
        completed_at: null,
      }],
    },
    heartbeatJobs: { 202: sharedRunnerJobs },
  }));

  assert.equal(inventory.hasQueuedPortableWork, true);
  assert.equal(inventory.hasQueuedDatabaseWork, true);
  assert.deepEqual(inventory.roles, {
    portable: { state: 'busy', reason: 'shared-runner-other-work', runnerName: undefined },
    database: { state: 'busy', reason: 'shared-runner-other-work', runnerName: undefined },
  });
});

test('the current planner run releases its shared listener before dependent work starts', async () => {
  const sharedRunnerJobs = [
    heartbeatJob('External Linux heartbeat (portable)', portable, 'shared-runner'),
    heartbeatJob('External Linux heartbeat (database)', database, 'shared-runner'),
  ];
  const inventory = await inspectWithCurrentRun(capacityRequest({
    inProgressRuns: [{ id: 201, status: 'in_progress' }],
    activeJobs: {
      201: [{
        name: 'Plan PR validation',
        status: 'in_progress',
        conclusion: null,
        runner_name: 'shared-runner',
        labels: ['self-hosted', 'Linux', 'example-trusted-control'],
        started_at: '2026-09-21T13:59:00Z',
        completed_at: null,
      }],
    },
    heartbeatJobs: { 202: sharedRunnerJobs },
  }), '201');

  assert.equal(inventory.hasQueuedPortableWork, false);
  assert.equal(inventory.hasQueuedDatabaseWork, false);
  assert.deepEqual(inventory.roles, {
    portable: { state: 'idle', reason: 'heartbeat-fresh', runnerName: 'shared-runner' },
    database: { state: 'idle', reason: 'heartbeat-fresh', runnerName: 'shared-runner' },
  });
});

test('a saturation-like inventory failure overflows to hosted only with fresh evidence', () => {
  const route = (hostedAvailable: boolean, externalInventorySaturated: boolean) =>
    selectPrLinuxRunners({
      sameRepository: true,
      checkLabels: portable,
      databaseLabels: database,
      hostedAvailable,
      externalInventoryAvailable: false,
      externalInventorySaturated,
    });
  assert.deepEqual(route(true, true), {
    checks: hosted,
    database,
    overflow: hosted,
    reason: 'external-inventory-unavailable-hosted-overflow',
  });
  const external = {
    checks: portable,
    database,
    overflow: portable,
    reason: 'external-inventory-unavailable',
  };
  assert.deepEqual(route(false, true), external);
  assert.deepEqual(route(true, false), external);
});

test('a saturation-like inventory failure never changes the fork route', () => {
  for (const hostedAvailable of [true, false]) {
    const selection = selectPrLinuxRunners({
      sameRepository: false,
      checkLabels: portable,
      databaseLabels: database,
      hostedAvailable,
      externalInventoryAvailable: false,
      externalInventorySaturated: true,
    });
    assert.deepEqual([selection.checks, selection.database, selection.overflow],
      [hosted, hosted, hosted]);
    assert.equal(selection.reason,
      hostedAvailable ? 'fork-hosted-only' : 'fork-hosted-unavailable');
  }
});

test('rate limits, server errors and timeouts mark the inventory failure as saturation', async () => {
  const failingWith = (status: number): ApiRequest => async () => ({
    ok: false, status, json: async () => ({}),
  });
  const cases = [[403, true], [429, true], [502, true], [404, false]] as const;
  for (const [status, saturationLikely] of cases) {
    const error: unknown = await inspectWith(failingWith(status)).then(
      () => assert.fail(`HTTP ${status} must reject`),
      (rejection: unknown) => rejection,
    );
    assert.ok(error instanceof ExternalInventoryError);
    assert.match(error.message, new RegExp(`HTTP ${status}`));
    assert.equal(inventoryFailureSuggestsSaturation(error), saturationLikely);
  }
  const timeout = new Error('The operation was aborted due to timeout');
  timeout.name = 'TimeoutError';
  assert.equal(inventoryFailureSuggestsSaturation(timeout), true);
  assert.equal(inventoryFailureSuggestsSaturation(
    new Error('job inventory returned an invalid payload')), false);
});

function queuedLaneRuns(count: number, labelSets: readonly (readonly string[])[]) {
  const queuedRuns: WorkflowRun[] = [];
  const activeJobs: Record<string, readonly WorkflowJob[]> = {};
  for (let index = 0; index < count; index += 1) {
    const id = 1000 + index;
    queuedRuns.push({ id, status: 'queued' });
    activeJobs[id] = labelSets.map(labels => ({
      name: 'Queued lane work', status: 'queued', conclusion: null, runner_name: '', labels,
    }));
  }
  return { queuedRuns, activeJobs };
}

function countingRequest(inner: ApiRequest): { request: ApiRequest; readonly urls: string[] } {
  const urls: string[] = [];
  return { urls, request: async (url, init) => {
    urls.push(url);
    return inner(url, init);
  } };
}

test('a saturated inventory stops reading active runs once both roles are busy', async () => {
  const { request, urls } = countingRequest(capacityRequest(
    queuedLaneRuns(90, [portable, database]),
  ));
  const inventory = await inspectWith(request);
  assert.equal(inventory.roles.portable.reason, 'active-portable-work');
  assert.equal(inventory.roles.database.reason, 'active-database-work');
  const activeJobReads = urls.filter(url => /\/actions\/runs\/1\d{3}\/jobs/.test(url));
  assert.equal(activeJobReads.length, 10);
  assert.ok(urls.some(url => url.includes('linux-runner-heartbeat.yml/runs?status=completed')
    && url.includes('per_page=2&')));
  // 2 run lists (one page each) + heartbeat list + pr-checks list
  // + 1 heartbeat run's jobs + 10 active runs' jobs; before: + 90 active runs' jobs.
  assert.equal(urls.length, 15);
});

test('a portable-only plan proves backlog from the oldest queued run before scanning unrelated work', async () => {
  const queuedJob = (labels: readonly string[], status: string): WorkflowJob => ({
    name: 'Queued lane work', status, conclusion: null, runner_name: '', labels,
  });
  const queuedRuns = Array.from({ length: 50 }, (_, index) => ({
    id: 1000 + index,
    status: 'queued',
    created_at: new Date(Date.UTC(2026, 8, 21, 14, 50 - index)).toISOString(),
  }));
  const activeJobs = Object.fromEntries(queuedRuns.map((run, index) => [run.id,
    index === 49 ? [queuedJob(portable, 'queued')]
      : [queuedJob(['macOS', 'ios-xcode'], 'queued')],
  ]));
  const inProgressRuns = Array.from({ length: 50 }, (_, index) => ({
    id: 2000 + index, status: 'in_progress',
  }));
  const unrelatedJobs = Object.fromEntries(inProgressRuns.map(run => [run.id,
    [queuedJob(['macOS', 'ios-xcode'], 'in_progress')],
  ]));
  const { request, urls } = countingRequest(capacityRequest({
    queuedRuns, inProgressRuns, activeJobs: { ...activeJobs, ...unrelatedJobs },
  }));
  const inventory = await inspectWith(request, false);
  assert.equal(inventory.roles.portable.reason, 'active-portable-work');
  assert.equal(urls.filter(url => /\/actions\/runs\/[12]\d{3}\/jobs/.test(url)).length, 10);
  assert.equal(urls.some(url => url.includes('/actions/runs/1049/jobs')), true);
  assert.equal(urls.some(url => url.includes('/actions/runs/2000/jobs')), false);
});

test('database demand in progress is inspected before a large queued portable backlog exhausts the scan', async () => {
  const queued = queuedLaneRuns(50, [portable]);
  const { request, urls } = countingRequest(capacityRequest({
    ...queued,
    inProgressRuns: [{ id: 2000, status: 'in_progress' }],
    activeJobs: {
      ...queued.activeJobs,
      2000: [{
        name: 'Database integration', status: 'in_progress', conclusion: null,
        runner_name: 'database-runner', labels: database,
      }],
    },
  }));
  const inventory = await inspectWith(request);
  assert.equal(inventory.roles.portable.reason, 'active-portable-work');
  assert.equal(inventory.roles.database.reason, 'active-database-work');
  assert.equal(urls.some(url => url.includes('/actions/runs/2000/jobs')), true);
  assert.equal(urls.filter(url => /\/actions\/runs\/[12]\d{3}\/jobs/.test(url)).length, 20);
});

test('an unsaturated inventory still reads every active run for an idle verdict', async () => {
  const { request, urls } = countingRequest(capacityRequest(
    queuedLaneRuns(25, [['macOS', 'ios-xcode']]),
  ));
  const inventory = await inspectWith(request);
  assert.deepEqual(inventory.roles, idleCapacity);
  assert.equal(urls.filter(url => /\/actions\/runs\/1\d{3}\/jobs/.test(url)).length, 25);
});

test('too many active runs without both roles busy is a saturation-like failure', async () => {
  const { request, urls } = countingRequest(capacityRequest(
    queuedLaneRuns(45, [portable]),
  ));
  const error: unknown = await inspectWith(request).then(
    () => assert.fail('an unresolved scan must reject'),
    (rejection: unknown) => rejection,
  );
  assert.ok(error instanceof ExternalInventoryError);
  assert.equal(inventoryFailureSuggestsSaturation(error), true);
  assert.equal(urls.filter(url => /\/actions\/runs\/1\d{3}\/jobs/.test(url)).length, 40);
});

test('a truncated scan still admits hosted overflow on fresh hosted work', async () => {
  const [inventory] = await Promise.allSettled([inspectWith(capacityRequest({
    ...queuedLaneRuns(45, [portable]),
    recentWorkRuns: [{ id: 303, status: 'completed', conclusion: 'success' }],
    recentWorkJobs: { 303: [hostedWorkJob()] },
  }))]);
  assert.equal(inventory.status, 'rejected');
  assert.equal(inventoryFailureSuggestsSaturation(inventory.reason), true);
  const recentWork = recentHostedWorkFromInventory(inventory);
  assert.deepEqual(recentWork, freshHostedWork);
  const { admission, dispatched } = await resolveWith(staleProbeFixture, {
    ...(recentWork === undefined ? {} : { recentWork }),
  });
  assert.deepEqual(admission, freshHostedWork);
  assert.equal(dispatched.length, 0);
  assert.deepEqual(selectPrLinuxRunners({
    sameRepository: true,
    checkLabels: portable,
    databaseLabels: database,
    hostedAvailable: admission.available,
    externalInventoryAvailable: false,
    externalInventorySaturated: true,
  }), {
    checks: hosted,
    database,
    overflow: hosted,
    reason: 'external-inventory-unavailable-hosted-overflow',
  });
});

test('a heartbeat read that fails during the active scan is handled, not unhandled', async () => {
  const unhandled: unknown[] = [];
  const onUnhandled = (reason: unknown) => { unhandled.push(reason); };
  process.on('unhandledRejection', onUnhandled);
  try {
    const inner = capacityRequest(queuedLaneRuns(5, [portable, database]));
    const request: ApiRequest = async (url, init) => {
      if (url.includes('/actions/runs/202/jobs')) {
        return { ok: false, status: 403, json: async () => ({}) };
      }
      if (/\/actions\/runs\/1\d{3}\/jobs/.test(url)) {
        await new Promise(resolve => setTimeout(resolve, 20));
      }
      return inner(url, init);
    };
    const [inventory] = await Promise.allSettled([inspectWith(request)]);
    await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(unhandled, []);
    assert.equal(inventory.status, 'rejected');
    assert.equal(inventoryFailureSuggestsSaturation(inventory.reason), true);
    const route = (hostedAvailable: boolean) => selectPrLinuxRunners({
      sameRepository: true,
      checkLabels: portable,
      databaseLabels: database,
      hostedAvailable,
      externalInventoryAvailable: false,
      externalInventorySaturated: inventoryFailureSuggestsSaturation(inventory.reason),
    }).reason;
    assert.equal(route(true), 'external-inventory-unavailable-hosted-overflow');
    assert.equal(route(false), 'external-inventory-unavailable');
  } finally {
    process.off('unhandledRejection', onUnhandled);
  }
});

function stalledRequest(): ApiRequest {
  return (_url, init) => new Promise((_resolve, reject) => {
    const signal = init?.signal;
    assert.ok(signal, 'every GitHub request must carry an abort signal');
    signal.addEventListener('abort', () => { reject(signal.reason); }, { once: true });
  });
}

test('a stalled hosted admission read is aborted within the bound and fails closed', async () => {
  const startedAt = Date.now();
  const resolveStalled = (recentWork?: HostedAdmission) => resolveHostedAdmission({
    apiUrl: 'https://api.github.test', repository: 'example-org/example-app',
    defaultBranch: 'develop', token: 'test-token', request: stalledRequest(), now,
    requestRefresh: true, timeoutMs: 25,
    ...(recentWork === undefined ? {} : { recentWork }),
  });
  const admission = await resolveStalled();
  assert.ok(Date.now() - startedAt < 2_000);
  assert.deepEqual(admission, { available: false, reason: 'hosted-admission-timeout' });
  // An unreadable probe is unknown, not failed: fresh hosted work still admits.
  assert.deepEqual(await resolveStalled(freshHostedWork), freshHostedWork);
  assert.deepEqual(selectPrLinuxRunners({
    sameRepository: true,
    checkLabels: portable,
    databaseLabels: database,
    hostedAvailable: admission.available,
    externalInventoryAvailable: false,
    externalInventorySaturated: true,
  }), {
    checks: portable,
    database,
    overflow: portable,
    reason: 'external-inventory-unavailable',
  });
});

test('a stalled inventory read is aborted within the bound as a saturation signal', async () => {
  const [inventory] = await Promise.allSettled([inspectExternalCapacity({
    apiUrl: 'https://api.github.test',
    repository: 'example-org/example-app',
    token: 'test-token',
    request: stalledRequest(),
    now,
    timeoutMs: 25,
  })]);
  assert.equal(inventory.status, 'rejected');
  assert.equal(inventoryFailureSuggestsSaturation(inventory.reason), true);
});

interface RateLimitedPlanFixture {
  readonly probeRuns?: readonly WorkflowRun[];
  readonly probeJobs?: Readonly<Record<string, readonly WorkflowJob[]>>;
  readonly probeReadable: boolean;
  readonly recentJobs: readonly WorkflowJob[];
}

/**
 * Mirrors main(): the probe and the inventory are read concurrently, the
 * active-run listing hits the token-wide 403, and admission is then decided
 * with the reads already settled.
 */
async function planUnderRateLimit(fixture: RateLimitedPlanFixture) {
  const probe = probeRequest({
    runs: fixture.probeRuns ?? [],
    ...(fixture.probeJobs === undefined ? {} : { jobs: fixture.probeJobs }),
  });
  const forbidden = { ok: false, status: 403, json: async () => ({}) };
  const inventory = capacityRequest({
    recentWorkRuns: [{ id: 303, status: 'completed', conclusion: 'success' }],
    recentWorkJobs: { 303: fixture.recentJobs },
  });
  let settled = false;
  const afterSettled: string[] = [];
  const request: ApiRequest = async (url, init) => {
    if (settled) afterSettled.push(url);
    if (url.includes('hosted-linux-admission.yml') || url.includes('/actions/runs/101/jobs')) {
      return fixture.probeReadable ? probe.request(url, init) : forbidden;
    }
    if (url.includes('/actions/runs?status=')) return forbidden;
    return inventory(url, init);
  };
  const base = {
    apiUrl: 'https://api.github.test', repository: 'example-org/example-app',
    defaultBranch: 'develop', token: 'test-token', request, now,
  };
  const [[inventoryResult], probeResult] = await Promise.all([
    Promise.allSettled([inspectWith(request)]),
    readHostedProbe(base),
  ]);
  settled = true;
  assert.equal(inventoryResult.status, 'rejected');
  const saturated = inventoryFailureSuggestsSaturation(inventoryResult.reason);
  assert.equal(saturated, true);
  const recentWork = recentHostedWorkFromInventory(inventoryResult);
  const admission = await finishHostedAdmission({
    ...base,
    probe: probeResult,
    requestRefresh: true,
    ...(recentWork === undefined ? {} : { recentWork }),
  });
  const route = selectPrLinuxRunners({
    sameRepository: true,
    checkLabels: portable,
    databaseLabels: database,
    hostedAvailable: admission.available,
    externalInventoryAvailable: false,
    externalInventorySaturated: saturated,
  });
  return {
    admission,
    route: route.reason,
    probeRead: probeResult.status,
    requestsAfterFailure: afterSettled.filter(url => !url.endsWith('/dispatches')),
  };
}

test('a token-wide 403 routes fresh hosted work to hosted with no further request', async () => {
  const result = await planUnderRateLimit({
    probeRuns: staleProbeFixture.runs,
    ...(staleProbeFixture.jobs === undefined ? {} : { probeJobs: staleProbeFixture.jobs }),
    probeReadable: true,
    recentJobs: [hostedWorkJob()],
  });
  assert.equal(result.probeRead, 'fulfilled');
  assert.deepEqual(result.admission, freshHostedWork);
  assert.equal(result.route, 'external-inventory-unavailable-hosted-overflow');
  assert.deepEqual(result.requestsAfterFailure, []);
});

test('a newer failed probe read alongside the inventory still blocks overflow', async () => {
  const result = await planUnderRateLimit({
    probeRuns: [{ ...successfulRun, conclusion: 'failure', updated_at: '2026-09-21T13:56:00Z' }],
    probeReadable: true,
    recentJobs: [hostedWorkJob()],
  });
  assert.equal(result.probeRead, 'fulfilled');
  assert.deepEqual(result.admission, { available: false, reason: 'hosted-probe-failed' });
  assert.equal(result.route, 'external-inventory-unavailable');
  assert.deepEqual(result.requestsAfterFailure, []);
});

test('an unreadable probe admits on fresh hosted work alone and refuses without it', async () => {
  const admitted = await planUnderRateLimit({ probeReadable: false, recentJobs: [hostedWorkJob()] });
  assert.deepEqual(admitted.admission, freshHostedWork);
  assert.equal(admitted.route, 'external-inventory-unavailable-hosted-overflow');
  assert.deepEqual(admitted.requestsAfterFailure, []);
  const refused = await planUnderRateLimit({
    probeReadable: false,
    recentJobs: [hostedWorkJob({ started_at: '2026-09-21T12:50:00Z' })],
  });
  assert.deepEqual(refused.admission,
    { available: false, reason: 'hosted-probe-inventory-unavailable' });
  assert.equal(refused.route, 'external-inventory-unavailable');
  assert.deepEqual(refused.requestsAfterFailure, []);
});

test('a failed or stalled probe dispatch never changes the route', async () => {
  for (const [request, reason] of [
    [stalledRequest(), 'hosted-probe-dispatch-timeout'],
    [async () => { throw new TypeError('fetch failed'); }, 'hosted-probe-dispatch-failed'],
  ] as const) {
    const admission = await finishHostedAdmission({
      apiUrl: 'https://api.github.test', repository: 'example-org/example-app',
      defaultBranch: 'develop', token: 'test-token', now, timeoutMs: 25,
      probe: { status: 'fulfilled', value: {
        admission: { available: false, reason: 'hosted-probe-stale' },
        run: successfulRun,
        pending: false,
      } },
      requestRefresh: true,
      request,
    });
    assert.deepEqual(admission, { available: false, reason });
  }
});

test('unreadable recent work keeps heartbeat capacity instead of failing the inventory', async () => {
  const inner = capacityRequest();
  const request: ApiRequest = async (url, init) => (
    url.includes('/actions/workflows/pr-checks.yml/runs')
      ? { ok: false, status: 502, json: async () => ({}) }
      : inner(url, init)
  );
  const inventory = await inspectWith(request);
  assert.deepEqual(inventory.roles, idleCapacity);
  assert.deepEqual(inventory.recentHostedWork,
    { available: false, reason: 'hosted-recent-work-unreadable' });
});

test('a truncated scan carries per-role proven demand into the saturation route', async () => {
  const inspectDedicated = async (labelSets: readonly (readonly string[])[]) => {
    const [result] = await Promise.allSettled([inspectExternalCapacity({
      apiUrl: 'https://api.github.test',
      repository: 'example-org/example-app',
      token: 'test-token',
      checkLabels: explicitPortable,
      databaseLabels: explicitDatabase,
      request: capacityRequest(queuedLaneRuns(45, labelSets)),
      now,
    })]);
    return result;
  };
  const route = (externalProvenBusy: { portable: boolean; database: boolean }) => {
    const selection = selectPrLinuxRunners({
      sameRepository: true,
      checkLabels: explicitPortable,
      databaseLabels: explicitDatabase,
      hostedAvailable: true,
      externalInventoryAvailable: false,
      externalInventorySaturated: true,
      externalProvenBusy,
    });
    assert.equal(selection.reason, 'external-inventory-unavailable-hosted-overflow');
    return [selection.checks, selection.database, selection.overflow];
  };
  const cases = [
    { name: 'only database', labels: [explicitDatabase],
      proven: { portable: false, database: true }, database: hosted },
    { name: 'only portable', labels: [explicitPortable],
      proven: { portable: true, database: false }, database: explicitDatabase },
    { name: 'neither', labels: [['macOS', 'ios-xcode']],
      proven: { portable: false, database: false }, database: explicitDatabase },
  ];
  for (const entry of cases) {
    const inventory = await inspectDedicated(entry.labels);
    assert.equal(inventory.status, 'rejected', entry.name);
    assert.equal(inventoryFailureSuggestsSaturation(inventory.reason), true, entry.name);
    assert.deepEqual(provenBusyFromInventory(inventory), entry.proven, entry.name);
    // Portable follows the saturation default (hosted) whether proven or unknown.
    assert.deepEqual(route(entry.proven), [hosted, entry.database, hosted], entry.name);
  }
  // Both proven stops the scan early, so the inventory succeeds; the
  // saturation route with both proven sends both roles to hosted.
  const both = await inspectDedicated([explicitPortable, explicitDatabase]);
  assert.equal(both.status, 'fulfilled');
  assert.deepEqual(provenBusyFromInventory(both), { portable: false, database: false });
  assert.deepEqual(route({ portable: true, database: true }), [hosted, hosted, hosted]);
  // Forks are unchanged by proven demand.
  const fork = selectPrLinuxRunners({
    sameRepository: false,
    checkLabels: explicitPortable,
    databaseLabels: explicitDatabase,
    hostedAvailable: true,
    externalInventoryAvailable: false,
    externalInventorySaturated: true,
    externalProvenBusy: { portable: false, database: true },
  });
  assert.deepEqual([fork.checks, fork.database, fork.overflow, fork.reason],
    [hosted, hosted, hosted, 'fork-hosted-only']);
});

test('a failed sibling read keeps database demand proven in the same batch', async () => {
  const inner = capacityRequest(queuedLaneRuns(5, [explicitDatabase]));
  const request: ApiRequest = async (url, init) => (
    url.includes('/actions/runs/1000/jobs')
      ? { ok: false, status: 403, json: async () => ({}) }
      : inner(url, init)
  );
  const [inventory] = await Promise.allSettled([inspectExternalCapacity({
    apiUrl: 'https://api.github.test',
    repository: 'example-org/example-app',
    token: 'test-token',
    checkLabels: explicitPortable,
    databaseLabels: explicitDatabase,
    request,
    now,
  })]);
  assert.equal(inventory.status, 'rejected');
  assert.equal(inventoryFailureSuggestsSaturation(inventory.reason), true);
  const provenBusy = provenBusyFromInventory(inventory);
  assert.deepEqual(provenBusy, { portable: false, database: true });
  const selection = selectPrLinuxRunners({
    sameRepository: true,
    checkLabels: explicitPortable,
    databaseLabels: explicitDatabase,
    hostedAvailable: true,
    externalInventoryAvailable: false,
    externalInventorySaturated: true,
    externalProvenBusy: provenBusy,
  });
  assert.deepEqual(selection.database, hosted);
});

test('success and truncated-failure paths compute identical per-role demand', async () => {
  const job = (overrides: Partial<WorkflowJob>): WorkflowJob => ({
    name: 'Evidence job', status: 'queued', conclusion: null, runner_name: '',
    labels: ['macOS', 'ios-xcode'], ...overrides,
  });
  const cases: readonly {
    readonly name: string;
    readonly jobs: readonly WorkflowJob[];
    readonly demand: { readonly portable: boolean; readonly database: boolean };
  }[] = [
    { name: 'portable job running on the database heartbeat runner',
      jobs: [job({ status: 'in_progress', labels: portable, runner_name: 'database-runner' })],
      demand: { portable: true, database: true } },
    { name: 'trusted-control job running on the database heartbeat runner',
      jobs: [job({ status: 'in_progress', labels: trustedControl, runner_name: 'database-runner' })],
      demand: { portable: false, database: true } },
    { name: 'trusted-control job running on the portable heartbeat runner',
      jobs: [job({ status: 'in_progress', labels: trustedControl, runner_name: 'portable-runner' })],
      demand: { portable: true, database: false } },
    { name: 'queued portable job',
      jobs: [job({ labels: portable })],
      demand: { portable: true, database: false } },
    { name: 'no Linux lane evidence',
      jobs: [job({})],
      demand: { portable: false, database: false } },
  ];
  const fixture = (runCount: number, evidence: readonly WorkflowJob[]) => {
    const queuedRuns: WorkflowRun[] = [];
    const activeJobs: Record<string, readonly WorkflowJob[]> = {};
    for (let index = 0; index < runCount; index += 1) {
      queuedRuns.push({ id: 1000 + index, status: 'queued' });
      activeJobs[1000 + index] = index === 0 ? evidence : [job({})];
    }
    return capacityRequest({ queuedRuns, activeJobs });
  };
  for (const entry of cases) {
    const success = await inspectWith(fixture(5, entry.jobs));
    assert.deepEqual({
      portable: success.hasQueuedPortableWork,
      database: success.hasQueuedDatabaseWork,
    }, entry.demand, `success: ${entry.name}`);
    const [failure] = await Promise.allSettled([inspectWith(fixture(45, entry.jobs))]);
    assert.equal(failure.status, 'rejected', entry.name);
    assert.deepEqual(provenBusyFromInventory(failure), entry.demand, `failure: ${entry.name}`);
  }
});
