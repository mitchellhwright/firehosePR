import { FAILSAFE_SCHEMA, load } from 'js-yaml';

import type { QueueReuseLane } from './queueEvidenceReuseRecord.ts';

/** Every iOS status context required by develop protection, besides the gate. */
const REQUIRED_VERDICT_JOBS = [
  'test-ios', 'storekit-purchase-status', 'onboarding-e2e-status',
] as const;
const REQUIRED_VERDICT_JOB_IDS = new Set<string>(REQUIRED_VERDICT_JOBS);

const LANE_JOBS: Readonly<Record<QueueReuseLane, readonly string[]>> = {
  native: [
    'route-initial-control',
    'ios-change-gate',
    'confirm-current-ios-pr',
    'verify-ios-release-archive',
    'build-ios-native-test-products',
    'test-ios-execution',
    ...REQUIRED_VERDICT_JOBS,
  ],
  onboarding: ['route-initial-control', 'ios-change-gate', 'confirm-current-ios-pr', 'prepare-dev-e2e-schema', 'build-ios-e2e-test-products', 'onboarding-e2e', ...REQUIRED_VERDICT_JOBS],
  'chat-plaid': ['route-initial-control', 'ios-change-gate', 'confirm-current-ios-pr', 'prepare-dev-e2e-schema', 'build-ios-e2e-test-products', 'chat-plaid-e2e', ...REQUIRED_VERDICT_JOBS],
  income: ['route-initial-control', 'ios-change-gate', 'confirm-current-ios-pr', 'prepare-dev-e2e-schema', 'build-ios-e2e-test-products', 'income-e2e', ...REQUIRED_VERDICT_JOBS],
  budget: ['route-initial-control', 'ios-change-gate', 'confirm-current-ios-pr', 'prepare-dev-e2e-schema', 'build-ios-e2e-test-products', 'budget-e2e', ...REQUIRED_VERDICT_JOBS],
};

// Aggregate jobs observe results from every lane. Their complete definitions
// are compared, including `needs`; these known cross-lane dependencies are
// allowed without pulling the other lane's execution job into this contract.
const STATUS_JOB_CROSS_LANE_NEEDS = new Set([
  'await-retained-ios-predecessor',
  'verify-ios-release-archive',
  'build-ios-native-test-products',
  'test-ios-execution',
  'onboarding-e2e',
  'chat-plaid-e2e',
  'income-e2e',
  'budget-e2e',
  'prepare-dev-e2e-schema',
]);

function object(value: unknown): Record<string, unknown> | null {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null;
  const prototype: unknown = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null
    ? value as Record<string, unknown> : null;
}

function canonical(value: unknown): unknown {
  if (value === undefined || typeof value === 'bigint' || typeof value === 'symbol'
    || (typeof value === 'number' && (!Number.isFinite(value)
      || (Number.isInteger(value) && !Number.isSafeInteger(value))))) {
    throw new Error('Unsupported workflow scalar');
  }
  if (Array.isArray(value)) return value.map(canonical);
  const fields = object(value);
  if (value !== null && typeof value === 'object' && fields === null) {
    throw new Error('Unsupported workflow object');
  }
  return fields === null ? value : Object.fromEntries(
    Object.keys(fields).sort().map((key) => [key, canonical(fields[key])]),
  );
}

/**
 * The fields GitHub executes for one Mac lane. Job and step objects are kept
 * whole, including fields added later. A new root field or an unrecognized
 * dependency refuses comparison until its effect has been audited.
 * The initial admission and gate jobs are included because their dependency and outputs control Mac allocation.
 * Current-PR confirmation is included because these jobs depend on its result.
 * All three required verdict jobs are included for every lane because their
 * logic decides whether reused evidence satisfies the candidate's checks.
 */
function executionFields(
  parsed: unknown, selected: readonly string[], allowStatusCrossLaneNeeds: boolean,
): Record<string, unknown> | null {
  const workflow = object(parsed);
  if (workflow === null || Object.keys(workflow).some((key) => ![
    'name', 'run-name', 'on', 'permissions', 'concurrency', 'env', 'jobs',
  ].includes(key))) return null;
  const jobs = object(workflow.jobs);
  if (jobs === null) return null;
  const selectedJobs: Record<string, unknown> = {};
  for (const id of selected) {
    const job = object(jobs[id]);
    if (job === null || !Array.isArray(job.steps)) return null;
    const needs = typeof job.needs === 'string' ? [job.needs] : job.needs;
    if (needs !== undefined && (!Array.isArray(needs) || needs.some((need) =>
      typeof need !== 'string' || (!selected.includes(need)
        && (!allowStatusCrossLaneNeeds || !REQUIRED_VERDICT_JOB_IDS.has(id)
          || !STATUS_JOB_CROSS_LANE_NEEDS.has(need)))
    ))) return null;
    selectedJobs[id] = job;
  }
  return {
    permissions: workflow.permissions,
    concurrency: workflow.concurrency,
    env: workflow.env,
    jobs: selectedJobs,
  };
}

export function queueLaneExecutionContract(source: string, lane: QueueReuseLane): string | null {
  try {
    // The normal parse binds YAML types; the failsafe parse retains scalar
    // spellings, including 1 versus 1.0 in text-valued env and action inputs.
    // Both projections must agree before a workflow edit can reuse evidence.
    const values = executionFields(load(source), LANE_JOBS[lane], true);
    const spellings = executionFields(load(source, { schema: FAILSAFE_SCHEMA }), LANE_JOBS[lane], true);
    if (values === null || spellings === null) return null;
    return JSON.stringify(canonical({
      schema: 'example.ios-queue-lane-execution.v2', values, spellings,
    }));
  } catch {
    return null;
  }
}

export function sameQueueLaneExecutionContract(
  headSource: string,
  candidateSource: string,
  lane: QueueReuseLane,
): boolean {
  const head = queueLaneExecutionContract(headSource, lane);
  return head !== null && head === queueLaneExecutionContract(candidateSource, lane);
}

/** Complete dependency closure for the shared E2E product producer. New dependencies
 * are included automatically; missing jobs and cycles refuse evidence reuse. */
function productDependencies(parsed: unknown): readonly string[] | null {
  const workflow = object(parsed);
  const jobs = object(workflow?.jobs);
  if (jobs === null) return null;
  const complete = new Set<string>();
  const active = new Set<string>();
  function visit(id: string): boolean {
    if (active.has(id)) return false;
    if (complete.has(id)) return true;
    const job = object(jobs?.[id]);
    if (job === null) return false;
    const needs = job.needs === undefined ? []
      : typeof job.needs === 'string' ? [job.needs] : job.needs;
    if (!Array.isArray(needs) || needs.some((need) => typeof need !== 'string')) return false;
    active.add(id);
    for (const need of needs) if (!visit(need)) return false;
    active.delete(id);
    complete.add(id);
    return true;
  }
  return visit('build-ios-e2e-test-products') ? [...complete].sort() : null;
}

/** Product execution inputs exclude downstream consumers, but retain every field of
 * the producer, its admission/schema dependencies, and workflow-wide settings.
 * This is product equivalence only: downstream test evidence is still validated
 * separately against its complete lane contract and selected coverage. */
export function iosE2eProductWorkflowContract(source: string): string | null {
  try {
    const parsed: unknown = load(source);
    const parsedSpellings: unknown = load(source, { schema: FAILSAFE_SCHEMA });
    const selected = productDependencies(parsed);
    const spelledSelected = productDependencies(parsedSpellings);
    if (selected === null || spelledSelected === null
      || JSON.stringify(selected) !== JSON.stringify(spelledSelected)) return null;
    const values = executionFields(parsed, selected, false);
    const spellings = executionFields(parsedSpellings, selected, false);
    if (values === null || spellings === null) return null;
    // Dispatch defaults and event configuration can affect producer expressions.
    return JSON.stringify(canonical({
      schema: 'example.ios-e2e-product-workflow.v1',
      values: { ...values, on: object(parsed)?.on },
      spellings: { ...spellings, on: object(parsedSpellings)?.on },
    }));
  } catch {
    return null;
  }
}
