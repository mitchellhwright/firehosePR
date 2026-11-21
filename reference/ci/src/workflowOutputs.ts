import { prValidationPlanning } from './prValidationPlanning.ts';
import { readFileSync } from 'node:fs';
import { load } from 'js-yaml';
import { z } from 'zod';

/**
 * Typed inter-job contract for a GitHub Actions workflow.
 *
 * A workflow's jobs talk to each other only through `needs.<job>.outputs.<name>`
 * and `needs.<job>.result`, and a job's outputs only through `steps.<id>`. None
 * of that is checked by GitHub before a run: a reference to an output that was
 * renamed, an output that nothing reads, or a step id that no longer exists all
 * evaluate to empty strings at runtime and surface as a skipped job or a shell
 * `parameter null or not set` minutes into a Mac lane.
 *
 * This module parses a workflow into a typed graph and reports every such
 * mismatch as a structured issue. `workflowOutputContract` pins the outputs a
 * workflow is expected to expose so a rename is an explicit, reviewed change
 * rather than a silent one. Both run inside `npm run ci:check`.
 */

const expressionSchema = z.union([z.string(), z.number(), z.boolean()]);
const stepSchema = z.object({
  id: z.string().optional(),
  name: z.string().optional(),
  if: expressionSchema.optional(),
  uses: z.string().optional(),
  run: z.string().optional(),
  with: z.record(z.string(), z.unknown()).optional(),
  env: z.record(z.string(), z.unknown()).optional(),
}).passthrough();
const jobSchema = z.object({
  needs: z.union([z.string(), z.array(z.string())]).optional(),
  if: expressionSchema.optional(),
  'runs-on': z.unknown().optional(),
  outputs: z.record(z.string(), expressionSchema).optional(),
  env: z.record(z.string(), z.unknown()).optional(),
  strategy: z.unknown().optional(),
  steps: z.array(stepSchema).optional(),
}).passthrough();
const documentSchema = z.object({
  jobs: z.record(z.string(), jobSchema),
}).passthrough();

export type WorkflowJob = z.infer<typeof jobSchema>;
export type WorkflowGraph = z.infer<typeof documentSchema>;

export interface OutputIssue {
  readonly job: string;
  readonly message: string;
}

const needsOutputPattern = /needs\.([A-Za-z0-9_-]+)\.outputs\.([A-Za-z0-9_-]+)/g;
const needsResultPattern = /needs\.([A-Za-z0-9_-]+)\.result\b/g;
const stepsReferencePattern = /steps\.([A-Za-z0-9_-]+)\.(outputs\.[A-Za-z0-9_-]+|outcome|conclusion)/g;

export function parseWorkflowGraph(source: string): WorkflowGraph {
  return documentSchema.parse(load(source));
}

export function loadWorkflowGraph(path: string): WorkflowGraph {
  return parseWorkflowGraph(readFileSync(path, 'utf8'));
}

function needsOf(job: WorkflowJob): readonly string[] {
  if (job.needs === undefined) return [];
  return typeof job.needs === 'string' ? [job.needs] : job.needs;
}

/** Every string anywhere in a job, so a reference is found wherever it hides: `if`, `env`,
 * `with`, `run`, `runs-on`, `outputs`, `strategy`, and step or job `name` fields alike. */
function* expressions(job: WorkflowJob): Generator<string> {
  const visit = function* (value: unknown): Generator<string> {
    if (typeof value === 'string') { yield value; return; }
    if (Array.isArray(value)) { for (const entry of value) yield* visit(entry); return; }
    if (value && typeof value === 'object') { for (const entry of Object.values(value)) yield* visit(entry); }
  };
  yield* visit(job);
}

/**
 * Report every inter-job and step reference that cannot resolve, and every
 * declared job output that no other job reads.
 */
export function validateWorkflowOutputs(graph: WorkflowGraph): OutputIssue[] {
  const issues: OutputIssue[] = [];
  const consumed = new Map<string, Set<string>>();
  for (const [jobId, job] of Object.entries(graph.jobs)) {
    const needs = needsOf(job);
    const stepIds = new Set((job.steps ?? []).flatMap((step) => (step.id ? [step.id] : [])));
    for (const dependency of needs) {
      if (!(dependency in graph.jobs)) {
        issues.push({ job: jobId, message: `needs job "${dependency}", which does not exist` });
      }
    }
    for (const expression of expressions(job)) {
      for (const match of expression.matchAll(needsOutputPattern)) {
        const [, producer, outputName] = match;
        if (producer === undefined || outputName === undefined) continue;
        if (!needs.includes(producer)) {
          issues.push({ job: jobId, message: `reads needs.${producer}.outputs.${outputName} but does not list "${producer}" in needs` });
          continue;
        }
        const producerJob = graph.jobs[producer];
        if (producerJob === undefined || !(outputName in (producerJob.outputs ?? {}))) {
          issues.push({ job: jobId, message: `reads needs.${producer}.outputs.${outputName}, which "${producer}" does not declare` });
          continue;
        }
        if (!consumed.has(producer)) consumed.set(producer, new Set());
        consumed.get(producer)?.add(outputName);
      }
      for (const match of expression.matchAll(needsResultPattern)) {
        const producer = match[1];
        if (producer !== undefined && !needs.includes(producer)) {
          issues.push({ job: jobId, message: `reads needs.${producer}.result but does not list "${producer}" in needs` });
        }
      }
      for (const match of expression.matchAll(stepsReferencePattern)) {
        const stepId = match[1];
        if (stepId !== undefined && !stepIds.has(stepId)) {
          issues.push({ job: jobId, message: `references steps.${stepId}, which is not a step id in this job` });
        }
      }
    }
  }
  for (const [jobId, job] of Object.entries(graph.jobs)) {
    for (const outputName of Object.keys(job.outputs ?? {})) {
      if (!consumed.get(jobId)?.has(outputName)) {
        issues.push({ job: jobId, message: `declares output "${outputName}", which no other job reads` });
      }
    }
  }
  return issues;
}

/** The outputs each job of a workflow is expected to expose, as declared. */
export function declaredOutputs(graph: WorkflowGraph): Record<string, readonly string[]> {
  const result: Record<string, readonly string[]> = {};
  for (const [jobId, job] of Object.entries(graph.jobs)) {
    const names = Object.keys(job.outputs ?? {});
    if (names.length > 0) result[jobId] = [...names].sort();
  }
  return result;
}

/**
 * Pinned inter-job outputs. A job that gains, loses or renames an output must
 * change this list in the same PR, so the review sees the contract move rather
 * than discovering it as an empty string in a lane. `satisfies` keeps the shape
 * checked by tsc; the test compares it with what each workflow declares.
 */
export const workflowOutputContract = {
  '.github/workflows/ios-tests.yml': {
    'route-initial-control': ['control_runner_labels'],
    'ios-change-gate': [
      'base_update_deferred',
      'base_update_deferred_base_sha',
      'base_update_predecessor_run_id',
      'base_update_predecessor_run_ids',
      'base_update_superseded',
      'base_update_valid',
      'budget_required',
      'chat_plaid_required',
      'control_runner_labels',
      'evidence_required',
      'expected_base_ref',
      'expected_base_sha',
      'expected_head_sha',
      'income_required',
      'ios_evidence_macos_minimum_execution_free_kb',
      'ios_evidence_macos_minimum_free_kb',
      'ios_macos_minimum_execution_free_kb',
      'ios_macos_minimum_free_kb',
      'mac_runner_resolution',
      'main_required',
      'merge_queue_candidate_gone',
      'native_changed_files',
      'native_changed_files_explicit_empty',
      'native_execution_lanes',
      'native_execution_required',
      'native_full_execution_lanes',
      'native_handoff_required',
      'native_mode',
      'native_planned',
      'native_preparation',
      'native_release_archive_required',
      'native_should_run',
      'native_ui_method_owners',
      'native_ui_required',
      'onboarding_required',
      'pr_number',
      'production_promotion',
      'promotion_checkpoint_sha',
      'promotion_proven',
      'promotion_run_id',
      'queue_evidence_reuse',
      'real_server_evidence_reused',
      'rerun_ios_lanes',
      'reuse_e2e_products',
      'reused_e2e_head_sha',
      'reused_e2e_run_attempt',
      'reused_e2e_run_id',
      'should_run',
      'storekit_required',
      'verifier_sha',
    ],
    'confirm-current-ios-pr': ['current'],
    'build-ios-native-test-products': ['storekit_result'],
  },
  '.github/workflows/pr-checks.yml': {
    'route-initial-control': ['control_runner_labels'],
    [prValidationPlanning.id]: prValidationPlanning.outputs,
  },
} as const satisfies Record<string, Record<string, readonly string[]>>;

/** Workflows whose inter-job graph must validate with no issues at all. */
export const outputValidatedWorkflows = [
  '.github/workflows/ios-tests.yml',
  '.github/workflows/pr-checks.yml',
  '.github/workflows/cancel-blocked-pr-ci.yml',
  '.github/workflows/cancel-dequeued-candidate.yml',
  '.github/workflows/promotion-checkpoint.yml',
  '.github/workflows/refresh-pr-ci-after-base-edit.yml',
] as const;
