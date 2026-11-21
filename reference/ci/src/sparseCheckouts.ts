import { existsSync, readFileSync, statSync } from 'node:fs';
import { posix, resolve } from 'node:path';
import { stepInvocation } from './invokedSources.ts';
import { loadWorkflowGraph, type WorkflowGraph } from './workflowOutputs.ts';

/**
 * A sparse checkout must contain every file the scripts run from it read.
 *
 * A checkout step with `sparse-checkout` and `path` materialises only the
 * listed top-level directories. Later steps in the job run scripts under that
 * path, and those scripts read sibling files relative to their own location
 * (`new URL('../.github/workflows/x.yml', import.meta.url)`). This validator
 * pairs each sparse checkout with the scripts invoked from it and reports any
 * script, or any file a script reads, outside the sparse set. It runs inside
 * `npm run ci:check`.
 */

export interface SparseCheckoutIssue {
  readonly job: string;
  readonly message: string;
}

const relativeReadPattern = /new URL\(\s*'((?:\.\.?\/)[^']+)'|resolve\([^)]*'((?:\.\.?\/)[^']+)'/g;
const relativeImportPattern = /(?:from\s+|import\()\s*'((?:\.\.?\/)[\w./-]+\.(?:mjs|js|ts))'/g;

function sparseDirectories(value: unknown): readonly string[] | undefined {
  if (typeof value !== 'string') return undefined;
  return value.split('\n').map((line) => line.trim()).filter((line) => line.length > 0);
}

const scriptSuffix = '((?:scripts|ci)/[\\w./-]+\\.(?:sh|mjs|js|py|ts))';

/**
 * Scripts a shell block runs from the checkout at `checkoutPath`, named either
 * by the path itself or through a variable assigned `name="…/<checkoutPath>"`.
 * A checkout without `path` is the workspace root, where scripts are named
 * directly (`node scripts/x.mjs`).
 */
function scriptsRunFrom(
  checkoutPath: string | undefined,
  run: string,
  environment: Readonly<Record<string, unknown>> = {},
): readonly string[] {
  if (checkoutPath === undefined) {
    return [...run.matchAll(new RegExp(`(?:^|[\\s"'(=])${scriptSuffix}`, 'gm'))].map((match) => match[1] ?? '');
  }
  const literal = checkoutPath.replaceAll('.', '\\.');
  const aliases = [
    ...[...run.matchAll(new RegExp(`(\\w+)="[^"\\n]*/${literal}"`, 'g'))].map((match) => match[1] ?? ''),
    // A step `env` value naming the checkout path, for example an expression
    // that selects the trusted checkout for one event and `.` for another.
    ...Object.entries(environment)
      .filter(([, value]) => typeof value === 'string' && value.includes(`'${checkoutPath}'`))
      .map(([name]) => name),
  ];
  const prefixes = [literal, ...aliases.flatMap((alias) => [`\\$${alias}`, `\\$\\{${alias}\\}`])];
  return prefixes.flatMap((prefix) =>
    [...run.matchAll(new RegExp(`${prefix}/${scriptSuffix}`, 'g'))].map((match) => match[1] ?? ''));
}

function covered(sparse: readonly string[], repositoryPath: string): boolean {
  return sparse.some((directory) => repositoryPath === directory || repositoryPath.startsWith(`${directory}/`));
}

/**
 * Repository paths a script reads relative to itself, following relative
 * imports across directories. The imported module is itself a checkout
 * dependency, and it may recursively import or read further dependencies.
 */
function relativeReads(repositoryRoot: string, script: string, visited = new Set<string>()): readonly string[] {
  if (visited.has(script)) return [];
  visited.add(script);
  const scriptPath = resolve(repositoryRoot, script);
  if (!existsSync(scriptPath)) return [];
  const source = readFileSync(scriptPath, 'utf8');
  const directory = posix.dirname(script);
  const reads = [...source.matchAll(relativeReadPattern)].map((match) =>
    posix.normalize(posix.join(directory, match[1] ?? match[2] ?? ''))
  ).filter(path => path !== '..' && !path.startsWith('../'));
  for (const match of source.matchAll(relativeImportPattern)) {
    const imported = posix.normalize(posix.join(directory, match[1] ?? ''));
    if (imported.startsWith('../') || imported === '..') continue;
    reads.push(imported, ...relativeReads(repositoryRoot, imported, visited));
  }
  return reads;
}

function isCheckoutStep(step: { uses?: string | undefined }): boolean {
  return step.uses?.startsWith('actions/checkout') === true;
}

export function validateSparseCheckouts(graph: WorkflowGraph, repositoryRoot = process.cwd()): SparseCheckoutIssue[] {
  const issues: SparseCheckoutIssue[] = [];
  for (const [jobId, job] of Object.entries(graph.jobs)) {
    const steps = job.steps ?? [];
    steps.forEach((step, index) => {
      if (!isCheckoutStep(step)) return;
      const sparse = sparseDirectories(step.with?.['sparse-checkout']);
      const rawPath = step.with?.['path'];
      const checkoutPath = typeof rawPath === 'string' ? rawPath : undefined;
      if (sparse === undefined) return;
      // actions/checkout defaults to cone mode: git accepts directories, not
      // individual files. Check syntax before dependency coverage can mask it.
      const coneMode = step.with?.['sparse-checkout-cone-mode'];
      if (coneMode !== false && coneMode !== 'false') {
        for (const path of sparse) {
          const fullPath = resolve(repositoryRoot, path);
          if (existsSync(fullPath) && !statSync(fullPath).isDirectory()) {
            issues.push({ job: jobId, message: `cone-mode sparse checkout requires a directory, received file ${path}` });
          }
        }
      }
      const invoked = new Set<string>();
      for (const later of steps.slice(index + 1)) {
        // A later checkout at the same path replaces this one.
        if (isCheckoutStep(later) && (typeof later.with?.['path'] === 'string' ? later.with['path'] : undefined) === checkoutPath) break;
        for (const script of scriptsRunFrom(checkoutPath, stepInvocation(later), later.env ?? {})) invoked.add(script);
        // Local actions resolve from the workspace root, so a root sparse
        // checkout must include their metadata before GitHub can start them.
        if (checkoutPath === undefined && later.uses?.startsWith('./')) {
          const action = posix.normalize(later.uses.slice(2));
          if (!covered(sparse, action)) {
            issues.push({ job: jobId, message: `uses local action ${action}, which the sparse checkout [${sparse.join(', ')}] does not contain` });
          }
        }
      }
      const where = checkoutPath ?? 'the workspace root';
      for (const script of invoked) {
        if (!covered(sparse, script)) {
          issues.push({ job: jobId, message: `runs ${checkoutPath === undefined ? script : `${checkoutPath}/${script}`}, which the sparse checkout [${sparse.join(', ')}] does not contain` });
          continue;
        }
        for (const read of relativeReads(repositoryRoot, script)) {
          if (!covered(sparse, read)) {
            issues.push({ job: jobId, message: `${script} reads ${read}, which the sparse checkout [${sparse.join(', ')}] at ${where} does not contain` });
          }
        }
      }
    });
  }
  return issues;
}

export function sparseCheckoutIssuesFor(workflowPath: string, repositoryRoot = process.cwd()): SparseCheckoutIssue[] {
  return validateSparseCheckouts(loadWorkflowGraph(resolve(repositoryRoot, workflowPath)), repositoryRoot);
}
