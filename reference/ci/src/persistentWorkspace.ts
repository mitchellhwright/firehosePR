import { readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { loadWorkflowGraph, type WorkflowGraph } from './workflowOutputs.ts';

/**
 * Jobs that can land on the trusted control runners share one persistent
 * git workspace, and a `git fetch --filter=…` there is not a per-job choice:
 * git registers `origin` as a promisor remote with that filter as the default
 * for every later fetch from the same workspace. One blob-filtered checkout
 * in a change gate therefore made every other controller's fetch blobless,
 * and a later job that walked the fetched objects with no credentials died on
 * the lazy fetches that followed. This validator keeps partial-clone filters
 * off any job that can run on those runners.
 */

export interface PersistentWorkspaceIssue {
  readonly workflow: string;
  readonly job: string;
  readonly message: string;
}

const controlRunnerMarkers = [
  // Legacy generated workflows used this repository variable. Keep detecting
  // it while older admitted runs and frozen migration fixtures still exist.
  'CI_CONTROL_RUNNER_LABELS',
  // Current typed workflows route trusted controls with this immutable
  // capability label, either as a literal label array or inside the fork-safe
  // reviewed-revision expression.
  'example-trusted-control',
] as const;

function runsOnControlRunner(runsOn: unknown): boolean {
  const rendered = JSON.stringify(runsOn ?? '');
  return controlRunnerMarkers.some((marker) => rendered.includes(marker));
}

export function validatePersistentWorkspace(graph: WorkflowGraph, workflow: string): PersistentWorkspaceIssue[] {
  const issues: PersistentWorkspaceIssue[] = [];
  for (const [jobId, job] of Object.entries(graph.jobs)) {
    if (!runsOnControlRunner(job['runs-on'])) continue;
    for (const step of job.steps ?? []) {
      const filter = step.with?.['filter'];
      if (!step.uses?.startsWith('actions/checkout@') || filter === undefined) continue;
      issues.push({
        workflow,
        job: jobId,
        message: `${step.name ?? step.uses} sets filter: ${String(filter)}; a filtered fetch on the shared control-runner workspace makes every later fetch there partial`,
      });
    }
  }
  return issues;
}

export function persistentWorkspaceIssues(repositoryRoot = process.cwd()): PersistentWorkspaceIssue[] {
  const directory = resolve(repositoryRoot, '.github/workflows');
  return readdirSync(directory)
    .filter((name) => /\.ya?ml$/.test(name))
    .sort()
    .flatMap((name) => validatePersistentWorkspace(loadWorkflowGraph(join(directory, name)), `.github/workflows/${name}`));
}
