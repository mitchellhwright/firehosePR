import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';

import { load } from 'js-yaml';
import { z } from 'zod';

import {
  humanReadableNameSchema, requiredContextNameSchema,
  type WorkflowContractRegistry,
  type WorkflowLaneContract,
} from './workflowContract.ts';

const workflowStepSchema = z.object({ id: z.string().optional(), name: z.string().optional() }).passthrough();
const workflowJobSchema = z.object({
  name: z.string().optional(),
  needs: z.union([z.string(), z.array(z.string())]).optional(),
  'runs-on': z.unknown().optional(),
  concurrency: z.unknown().optional(),
  steps: z.array(workflowStepSchema).optional(),
}).passthrough();
const workflowDocumentSchema = z.object({
  name: z.string().optional(),
  concurrency: z.unknown().optional(),
  jobs: z.record(z.string(), workflowJobSchema),
}).passthrough();

export interface CompatibilityIssue { laneId: string; message: string }
export interface WorkflowCoverage { workflows: number; jobs: number; steps: number }
type WorkflowDocument = z.infer<typeof workflowDocumentSchema>;

function issue(laneId: string, message: string): CompatibilityIssue {
  return { laneId, message };
}

const legacyUiDebtEntrySchema = z.object({
  fingerprint: z.string().regex(/^[0-9a-f]{64}$/),
  surfaceId: z.string().min(1),
  message: z.string().min(1),
}).strict();

export const legacyUiDebtInventorySchema = z.object({
  schema: z.literal('example.legacy-ui-debt.v1'),
  baselineCount: z.number().int().nonnegative(),
  entries: z.array(legacyUiDebtEntrySchema),
}).strict().superRefine((inventory, context) => {
  if (inventory.baselineCount !== inventory.entries.length) {
    context.addIssue({ code: 'custom', message: 'Legacy debt count must equal its pinned inventory', path: ['baselineCount'] });
  }
  const fingerprints = inventory.entries.map((entry) => entry.fingerprint);
  if (new Set(fingerprints).size !== fingerprints.length) {
    context.addIssue({ code: 'custom', message: 'Legacy debt fingerprints must be unique', path: ['entries'] });
  }
  for (const [index, entry] of inventory.entries.entries()) {
    if (entry.fingerprint !== legacyUiDebtFingerprint(entry)) {
      context.addIssue({ code: 'custom', message: 'Legacy debt fingerprint does not match its issue', path: ['entries', index, 'fingerprint'] });
    }
  }
});
export type LegacyUiDebtInventory = z.infer<typeof legacyUiDebtInventorySchema>;

export function legacyUiDebtFingerprint(issueEntry: { surfaceId: string; message: string }): string {
  return createHash('sha256').update(`${issueEntry.surfaceId}\n${issueEntry.message}`).digest('hex');
}

export function legacyUiDebtIssues(issues: readonly CompatibilityIssue[]): CompatibilityIssue[] {
  return issues.filter((entry) => (
    entry.message === 'GitHub-visible surface is unnamed'
    || entry.message.startsWith('GitHub-visible name is opaque or generic:')
    || entry.message.startsWith('Expected UI name "')
    || entry.message.startsWith('Duplicate visible step name:')
  ));
}

export function validateLegacyUiDebt(
  issues: readonly CompatibilityIssue[],
  rawInventory: unknown,
): CompatibilityIssue[] {
  const inventory = legacyUiDebtInventorySchema.parse(rawInventory);
  const current = legacyUiDebtIssues(issues);
  const baseline = new Set(inventory.entries.map((entry) => entry.fingerprint));
  const currentFingerprints = new Set(current.map((entry) => legacyUiDebtFingerprint({
    surfaceId: entry.laneId,
    message: entry.message,
  })));
  const regressions = current.filter((entry) => !baseline.has(legacyUiDebtFingerprint({
    surfaceId: entry.laneId,
    message: entry.message,
  })));
  const result = regressions.map((entry) => issue(entry.laneId, `New legacy UI debt: ${entry.message}`));
  if (current.length !== inventory.baselineCount) {
    result.push(issue(
      'registry',
      `Legacy UI debt count ${current.length} differs from the pinned inventory count ${inventory.baselineCount}`,
    ));
  }
  for (const entry of inventory.entries) {
    if (!currentFingerprints.has(entry.fingerprint)) {
      result.push(issue(
        entry.surfaceId,
        'Pinned legacy UI debt is absent from current workflows; update the inventory in the same change',
      ));
    }
  }
  return result;
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    return `{${Object.entries(value).sort(([a], [b]) => a.localeCompare(b))
      .map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry)}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function normalizedNeeds(job: z.infer<typeof workflowJobSchema>): string[] {
  if (job.needs === undefined) return [];
  return typeof job.needs === 'string' ? [job.needs] : job.needs;
}

function runnerLabels(runsOn: unknown): string[] {
  const labels = Array.isArray(runsOn)
    ? runsOn
    : runsOn !== null && typeof runsOn === 'object'
      ? Object.entries(runsOn).find(([key]) => key === 'labels')?.[1]
      : undefined;
  return Array.isArray(labels) && labels.every((label) => typeof label === 'string')
    ? labels
    : [];
}

function hasPhysicalMacCapabilities(runsOn: unknown): boolean {
  const labels = runnerLabels(runsOn);
  if (labels.includes('self-hosted')
    && labels.includes('macOS')
    && labels.some((label) => label === 'ios-xcode' || label === 'ios-production-e2e')) return true;
  const dynamicLabels = runsOn !== null && typeof runsOn === 'object' && 'labels' in runsOn
    ? runsOn.labels : undefined;
  // The typed workflow emits exactly these two fixed alternatives. Require
  // both capabilities, so a dynamic route cannot hide a hosted Mac fallback.
  return typeof dynamicLabels === 'string'
    && dynamicLabels.startsWith('${{ fromJson(')
    && dynamicLabels.includes('["self-hosted","macOS","ios-xcode"]')
    && dynamicLabels.includes('["self-hosted","macOS","ios-reserved-mitchell"]');
}

function compareDependencies(
  lane: WorkflowLaneContract,
  job: z.infer<typeof workflowJobSchema>,
): CompatibilityIssue[] {
  const actual = [...normalizedNeeds(job)].sort();
  const expected = [...lane.dependencies].sort();
  if (JSON.stringify(actual) === JSON.stringify(expected)) return [];
  return [issue(
    lane.id,
    `Expected dependencies ${expected.join(',') || '(none)'}; found ${actual.join(',') || '(none)'}`,
  )];
}

function validateLane(
  lane: WorkflowLaneContract,
  workflows: ReadonlyMap<string, WorkflowDocument>,
): CompatibilityIssue[] {
  const workflow = workflows.get(lane.workflowPath);
  if (!workflow) return [issue(lane.id, `Missing workflow ${lane.workflowPath}`)];
  const job = workflow.jobs[lane.jobId];
  if (!job) return [issue(lane.id, `Missing job ${lane.jobId}`)];
  const issues = compareDependencies(lane, job);
  if (lane.runsOnCanonical !== canonicalJson(job['runs-on'])) {
    issues.push(issue(lane.id, 'Parsed runner contract differs from the pinned effective runs-on value'));
  }
  if (lane.runnerClass === 'macos-physical'
      && /macos-(?:latest|\d+)|xcode-\d+/i.test(canonicalJson(job['runs-on']))) {
    issues.push(issue(lane.id, 'Physical macOS lane references a hosted macOS image'));
  }
  if (lane.runnerClass === 'macos-physical' && !hasPhysicalMacCapabilities(job['runs-on'])) {
    issues.push(issue(lane.id, 'Physical macOS lane lacks the required self-hosted Mac capability labels'));
  }
  if (lane.concurrencyCanonical !== canonicalJson(job.concurrency)) {
    issues.push(issue(lane.id, 'Parsed concurrency contract differs from the pinned effective concurrency value'));
  }
  return issues;
}

function compareIds(
  surfaceId: string,
  label: string,
  expected: readonly string[],
  actual: readonly string[],
): CompatibilityIssue[] {
  return [
    ...expected.filter((id) => !actual.includes(id))
      .map((id) => issue(surfaceId, `Missing declared ${label} ${id}`)),
    ...actual.filter((id) => !expected.includes(id))
      .map((id) => issue(surfaceId, `Undeclared ${label} ${id}`)),
  ];
}

/**
 * A name may end in one parenthesised expression — the matrix shard, host
 * label or PR number that distinguishes one instance of a job from another,
 * which is exactly what `matrixSuffixed`/`suffixed` produce in
 * `ci/workflows/lib/names.ts`. The literal in front of it is the name the
 * registry declares and a person reads; anything else built from an
 * expression is opaque and stays a finding.
 */
const SUFFIX_EXPRESSION = / \(\$\{\{[^}]*\}\}\)$/;

function visibleLiteral(actual: string): string {
  return actual.replace(SUFFIX_EXPRESSION, '');
}

/** Display literals selected by a GitHub expression, excluding comparison operands. */
function conditionalDisplayLiterals(actual: string): string[] {
  return [...actual.matchAll(/(?:&&|\|\|)\s*'([^']+)'/g)]
    .map((match) => match[1])
    .filter((literal): literal is string => literal !== undefined);
}

function validateName(
  surfaceId: string,
  actual: string | undefined,
  expected: string,
): CompatibilityIssue[] {
  if (!actual) return [issue(surfaceId, 'GitHub-visible surface is unnamed')];
  const alternatives = conditionalDisplayLiterals(actual);
  if (alternatives.includes(expected) && alternatives.every((literal) => (
    humanReadableNameSchema.safeParse(literal).success
    || requiredContextNameSchema.safeParse(literal).success
  ))) return [];
  const literal = visibleLiteral(actual);
  const issues = humanReadableNameSchema.safeParse(literal).success
    ? []
    : [issue(surfaceId, `GitHub-visible name is opaque or generic: ${actual}`)];
  if (literal !== expected) {
    issues.push(issue(surfaceId, `Expected UI name "${expected}"; found "${actual}"`));
  }
  return issues;
}

export function parseWorkflowDocument(source: string): WorkflowDocument {
  return workflowDocumentSchema.parse(load(source));
}

export function validateWorkflowCoverage(
  registry: WorkflowContractRegistry,
  workflows: ReadonlyMap<string, WorkflowDocument>,
): CompatibilityIssue[] {
  const expectedPaths = registry.workflows.map((workflow) => workflow.path);
  const issues = compareIds('registry', 'workflow', expectedPaths, [...workflows.keys()]);
  for (const workflowContract of registry.workflows) {
    const workflow = workflows.get(workflowContract.path);
    if (!workflow) continue;
    issues.push(...compareIds(
      workflowContract.path,
      'job',
      workflowContract.jobs.map((job) => job.id),
      Object.keys(workflow.jobs),
    ));
    for (const jobContract of workflowContract.jobs) {
      const job = workflow.jobs[jobContract.id];
      if (!job) continue;
      const steps = job.steps ?? [];
      if (steps.length !== jobContract.steps.length) {
        issues.push(issue(
          `${workflowContract.path}:${jobContract.id}`,
          `Expected ${jobContract.steps.length} declared steps; found ${steps.length}`,
        ));
      }
      for (const stepContract of jobContract.steps) {
        const step = steps[stepContract.position - 1];
        if (step && step.id !== stepContract.workflowStepId) {
          issues.push(issue(
            `${workflowContract.path}:${jobContract.id}:${stepContract.id}`,
            `Expected workflow step id ${stepContract.workflowStepId ?? '(none)'}; found ${step.id ?? '(none)'}`,
          ));
        }
      }
    }
  }
  return issues;
}

export function validateWorkflowCompatibility(
  registry: WorkflowContractRegistry,
  workflows: ReadonlyMap<string, WorkflowDocument>,
): CompatibilityIssue[] {
  const issues = validateWorkflowCoverage(registry, workflows);
  for (const workflowContract of registry.workflows) {
    const workflow = workflows.get(workflowContract.path);
    if (!workflow) continue;
    if (workflowContract.concurrencyCanonical !== canonicalJson(workflow.concurrency)) {
      issues.push(issue(
        workflowContract.path,
        'Parsed workflow concurrency differs from the pinned effective concurrency value',
      ));
    }
    issues.push(...validateName(workflowContract.path, workflow.name, workflowContract.displayName));
    for (const jobContract of workflowContract.jobs) {
      const job = workflow.jobs[jobContract.id];
      if (!job) continue;
      const jobSurfaceId = `${workflowContract.path}:${jobContract.id}`;
      issues.push(...validateName(jobSurfaceId, job.name, jobContract.displayName));
      const seenNames = new Set<string>();
      for (const stepContract of jobContract.steps) {
        const step = (job.steps ?? [])[stepContract.position - 1];
        if (!step) continue;
        const stepSurfaceId = `${jobSurfaceId}:${stepContract.id}`;
        issues.push(...validateName(stepSurfaceId, step.name, stepContract.displayName));
        if (step.name && seenNames.has(step.name.toLowerCase())) {
          issues.push(issue(stepSurfaceId, `Duplicate visible step name: ${step.name}`));
        }
        if (step.name) seenNames.add(step.name.toLowerCase());
      }
    }
  }
  const duplicateLaneIds = registry.lanes
    .map((lane) => lane.id)
    .filter((id, index, ids) => ids.indexOf(id) !== index);
  issues.push(...duplicateLaneIds.map((id) => issue(id, 'Duplicate lane ID')));
  const laneJobs = new Set(registry.lanes.map((lane) => `${lane.workflowPath}:${lane.jobId}`));
  for (const [path, workflow] of workflows) {
    for (const jobId of Object.keys(workflow.jobs)) {
      if (!laneJobs.has(`${path}:${jobId}`)) {
        issues.push(issue(`${path}:${jobId}`, 'Workflow job has no typed lane policy'));
      }
    }
  }
  for (const lane of registry.lanes) issues.push(...validateLane(lane, workflows));
  return issues;
}

export function workflowCoverage(registry: WorkflowContractRegistry): WorkflowCoverage {
  return registry.workflows.reduce((coverage, workflow) => ({
    workflows: coverage.workflows + 1,
    jobs: coverage.jobs + workflow.jobs.length,
    steps: coverage.steps + workflow.jobs.reduce((count, job) => count + job.steps.length, 0),
  }), { workflows: 0, jobs: 0, steps: 0 });
}

export function loadRegisteredWorkflows(
  registry: WorkflowContractRegistry,
): Map<string, WorkflowDocument> {
  return new Map(registry.workflows.map((workflow) => [
    workflow.path,
    parseWorkflowDocument(readFileSync(workflow.path, 'utf8')),
  ]));
}

export function loadRepositoryWorkflows(directory = '.github/workflows'): Map<string, WorkflowDocument> {
  return new Map(readdirSync(directory)
    .filter((entry) => /\.ya?ml$/.test(entry))
    .sort()
    .map((entry) => {
      const path = `${directory}/${entry}`;
      return [path, parseWorkflowDocument(readFileSync(path, 'utf8'))];
    }));
}
