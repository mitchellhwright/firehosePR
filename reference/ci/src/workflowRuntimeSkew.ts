import { load } from 'js-yaml';
import { z } from 'zod';

/** Executable repository files a generated workflow invokes from its checkout. */
const runtimePath = /\b(?:ci\/src\/actions\/[A-Za-z0-9_./-]+\.ts|scripts\/[A-Za-z0-9_./-]+\.(?:sh|js|mjs|py))\b/g;
const runtimeSourcePath = /^(?:ci\/src\/actions\/[A-Za-z0-9_./-]+\.ts|scripts\/[A-Za-z0-9_./-]+\.(?:sh|js|mjs|py))$/;
const scriptPathCall = /\bscriptPath\(\s*['"]([A-Za-z0-9_./-]+\.(?:sh|js|mjs|py))['"]\s*\)/g;
const processLauncher = /\b(?:runCommand|execFile|spawn)\s*\(/g;

/** Keep runtime inventory dependency-free in the pre-Mac trusted tuple guard. */
function processInvocationBodies(source: string): readonly string[] {
  const bodies: string[] = [];
  for (const match of source.matchAll(processLauncher)) {
    const start = match.index + match[0].length;
    const line = source.slice(source.lastIndexOf('\n', match.index - 1) + 1, match.index).trimStart();
    if (line.startsWith('//') || line.startsWith('#')) continue;
    let depth = 1;
    let quote: '"' | "'" | '`' | undefined;
    let escaped = false;
    for (let index = start; index < source.length; index += 1) {
      const character = source[index];
      if (quote !== undefined) {
        if (escaped) escaped = false;
        else if (character === '\\') escaped = true;
        else if (character === quote) quote = undefined;
      } else if (character === '"' || character === "'" || character === '`') {
        quote = character;
      } else if (character === '(') {
        depth += 1;
      } else if (character === ')') {
        depth -= 1;
        if (depth === 0) {
          bodies.push(source.slice(start, index));
          break;
        }
      }
    }
  }
  return bodies;
}

/** Protected definitions that execute repository commands from an exact PR head. */
export const protectedPrRuntimeWorkflows = new Set([
  '.github/workflows/ios-tests.yml',
  '.github/workflows/pr-checks.yml',
]);

export function workflowRuntimeFiles(source: string): readonly string[] {
  const paths = new Set<string>();
  for (const match of source.matchAll(runtimePath)) {
    const path = match[0];
    const index = match.index ?? 0;
    const before = source.slice(Math.max(0, index - 100), index);
    const lineBefore = source.slice(source.lastIndexOf('\n', index - 1) + 1, index);
    if (lineBefore.trimStart().startsWith('#') || /hashFiles\(\s*['"]$/.test(before)
      || /contents\/$/.test(before)) continue;
    // A `.ci/<trusted-checkout>/` command executes from the protected base,
    // not the PR checkout. Requiring it at the PR head would force every old
    // branch to refresh even though the trusted job already has the file.
    if (/\.ci\/[^/\s]+\/$/.test(before) || before.endsWith('trusted-verifier/')) continue;
    paths.add(path);
  }
  return [...paths].sort();
}

const workflowStepSchema = z.object({
  run: z.string().optional(),
  uses: z.string().optional(),
  with: z.record(z.string(), z.unknown()).optional(),
  'working-directory': z.string().optional(),
}).passthrough();
const workflowSchema = z.object({
  jobs: z.record(z.string(), z.object({
    steps: z.array(workflowStepSchema).optional(),
    defaults: z.object({ run: z.object({ 'working-directory': z.string().optional() }).optional() }).optional(),
  }).passthrough()),
}).passthrough();

const scopedRuntimePath = /(?:^|[^A-Za-z0-9_./-])(\.ci\/[A-Za-z0-9_-]+)\/(ci\/src\/actions\/[A-Za-z0-9_./-]+\.ts|scripts\/[A-Za-z0-9_./-]+\.(?:sh|js|mjs|py))\b/g;

function trustedCheckoutRef(ref: unknown): boolean {
  return typeof ref === 'string'
    && /\b(?:verifier_sha|EXAMPLE_CI_TRUSTED_BASE_SHA|pull_request\.base\.sha)\b/.test(ref)
    && !/\b(?:pull_request\.head\.sha|EXAMPLE_CI_EXACT_HEAD_SHA)\b/.test(ref);
}

/**
 * Only executables run from the PR checkout can be missing from the PR head.
 * A job can replace its workspace with a proven base/verifier checkout before
 * invoking another program; scanning the whole YAML as text misattributes
 * those trusted programs to every PR and needlessly refreshes their heads.
 * Unknown checkout refs remain PR-head requirements (fail closed).
 */
export function prHeadWorkflowRuntimeFiles(source: string): readonly string[] {
  // Unit-sized source excerpts exercise the executable scanner itself. Full
  // generated workflows always have jobs and receive checkout-aware analysis.
  if (!/^jobs:\s*$/m.test(source)) return workflowRuntimeFiles(source);
  const workflow = workflowSchema.parse(load(source));
  const required = new Set<string>();
  for (const job of Object.values(workflow.jobs)) {
    let fromPrHead = true;
    const scopedCheckouts = new Map<string, boolean>();
    for (const step of job.steps ?? []) {
      if (step.uses?.startsWith('actions/checkout@')) {
        const checkoutPath = step.with?.['path'];
        const headOwned = !trustedCheckoutRef(step.with?.['ref']);
        if (typeof checkoutPath === 'string') scopedCheckouts.set(checkoutPath.replace(/\/$/, ''), headOwned);
        else fromPrHead = headOwned;
      }
      const inputs = Object.values(step.with ?? {}).filter((value): value is string => typeof value === 'string');
      const workingDirectory = step['working-directory'] ?? job.defaults?.run?.['working-directory'] ?? '';
      const scopedWorkdir = [...scopedCheckouts.keys()].find((path) =>
        workingDirectory === path || workingDirectory.startsWith(`${path}/`));
      const runFromHead = scopedWorkdir === undefined ? fromPrHead : scopedCheckouts.get(scopedWorkdir) !== false;
      if (runFromHead) {
        for (const path of workflowRuntimeFiles(step.run ?? '')) required.add(path);
      }
      // Inputs to local actions resolve from the root checkout, independent
      // of a run step's working-directory.
      if (fromPrHead) {
        for (const path of workflowRuntimeFiles(inputs.join('\n'))) required.add(path);
      }
      for (const text of [step.run ?? '', ...inputs]) {
        for (const match of text.matchAll(scopedRuntimePath)) {
          const checkout = match[1];
          const path = match[2];
          if (checkout !== undefined && path !== undefined && scopedCheckouts.get(checkout) !== false) {
            required.add(path);
          }
        }
      }
    }
  }
  return [...required].sort();
}

/** Script/action source may mention paths as data. Follow only command lines. */
export function runtimeSourceFiles(source: string): readonly string[] {
  const paths = new Set<string>();
  for (const line of source.split('\n')) {
    const trimmed = line.trimStart();
    if (trimmed.startsWith('#') || trimmed.startsWith('//')) continue;
    if (!/\b(?:node|bash|python3?|source|runCommand|execFile|spawn|scriptPath)\b/.test(line)
      && !/(?:^|[;(&|])\s*sh\s+/.test(line)) continue;
    for (const path of workflowRuntimeFiles(line)) paths.add(path);
    for (const match of line.matchAll(scriptPathCall)) {
      const relative = match[1];
      if (relative !== undefined && !relative.startsWith('../')) {
        paths.add(relative.startsWith('scripts/') ? relative : `scripts/${relative}`);
      }
    }
  }
  // A launcher often puts its executable on a later line. Inspect its whole
  // balanced argument list without loading TypeScript on the trusted guard.
  for (const body of processInvocationBodies(source)) {
    for (const path of workflowRuntimeFiles(body)) paths.add(path);
    for (const match of body.matchAll(scriptPathCall)) {
      const relative = match[1];
      if (relative !== undefined && !relative.startsWith('../')) {
        paths.add(relative.startsWith('scripts/') ? relative : `scripts/${relative}`);
      }
    }
  }
  return [...paths].sort();
}

/** New command edges inside a changed script or typed action. */
export function newlyRequiredRuntimeSourceFiles(
  beforeSources: readonly string[],
  afterSources: readonly string[],
): readonly string[] {
  if (beforeSources.length !== afterSources.length) {
    throw new Error('Runtime source revisions must be paired.');
  }
  const added = new Set<string>();
  for (let index = 0; index < afterSources.length; index += 1) {
    const before = new Set(runtimeSourceFiles(beforeSources[index] ?? ''));
    for (const path of runtimeSourceFiles(afterSources[index] ?? '')) {
      if (!before.has(path)) added.add(path);
    }
  }
  return [...added].sort();
}

/** Bounded, cycle-safe executable closure rooted in one generated workflow. */
export function workflowRuntimeClosure(
  workflowSource: string,
  readSource: (path: string) => string | undefined,
): readonly string[] {
  const required = new Set(prHeadWorkflowRuntimeFiles(workflowSource));
  const pending = [...required];
  for (let index = 0; index < pending.length; index += 1) {
    if (required.size > 500) throw new Error('Workflow runtime closure exceeded 500 files.');
    const path = pending[index];
    if (path === undefined || path.startsWith('scripts/tests/')) continue;
    const source = readSource(path);
    if (source === undefined) throw new Error(`Protected workflow runtime file is missing: ${path}`);
    for (const dependency of runtimeSourceFiles(source)) {
      if (required.has(dependency)) continue;
      required.add(dependency);
      pending.push(dependency);
    }
  }
  return [...required].sort();
}

/** Executables the protected workflow started requiring in this base push. */
export function newlyRequiredWorkflowRuntimeFiles(
  beforeSources: readonly string[],
  afterSources: readonly string[],
): readonly string[] {
  if (beforeSources.length !== afterSources.length) {
    throw new Error('Workflow revisions must be paired before checking new runtime files.');
  }
  const added = new Set<string>();
  for (let index = 0; index < afterSources.length; index += 1) {
    const before = new Set(workflowRuntimeFiles(beforeSources[index] ?? ''));
    for (const path of workflowRuntimeFiles(afterSources[index] ?? '')) {
      if (!before.has(path)) added.add(path);
    }
  }
  return [...added].sort();
}

/** New executable paths that an exact PR-head workspace actually has to supply. */
export function newlyRequiredPrHeadWorkflowRuntimeFiles(
  beforeSources: readonly string[],
  afterSources: readonly string[],
): readonly string[] {
  if (beforeSources.length !== afterSources.length) {
    throw new Error('Workflow revisions must be paired before checking new PR-head runtime files.');
  }
  const added = new Set<string>();
  for (let index = 0; index < afterSources.length; index += 1) {
    const before = new Set(prHeadWorkflowRuntimeFiles(beforeSources[index] ?? ''));
    for (const path of prHeadWorkflowRuntimeFiles(afterSources[index] ?? '')) {
      if (!before.has(path)) added.add(path);
    }
  }
  return [...added].sort();
}

export function missingWorkflowRuntimeFiles(
  required: readonly string[],
  headFiles: ReadonlySet<string>,
): readonly string[] {
  return required.filter((path) => !headFiles.has(path));
}

function asRecord(value: unknown): Readonly<Record<string, unknown>> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Readonly<Record<string, unknown>>
    : undefined;
}

/** A truncated or malformed Git tree cannot prove the PR checkout is safe. */
export function filesFromGithubTree(body: unknown): ReadonlySet<string> {
  const record = asRecord(body);
  if (record?.['truncated'] !== false || !Array.isArray(record['tree'])) {
    throw new Error('GitHub did not return a complete head file tree.');
  }
  const paths = new Set<string>();
  for (const item of record['tree']) {
    const entry = asRecord(item);
    if (typeof entry?.['path'] !== 'string' || typeof entry['type'] !== 'string') {
      throw new Error('GitHub returned a malformed head file tree.');
    }
    if (entry['type'] === 'blob') paths.add(entry['path']);
  }
  return paths;
}

export interface ChangedRuntimeSource {
  readonly filename: string;
  readonly status: 'added' | 'modified';
}

function blobVersionsFromGithubTree(body: unknown): ReadonlyMap<string, string> {
  const record = asRecord(body);
  if (record?.['truncated'] !== false || !Array.isArray(record['tree'])) {
    throw new Error('GitHub did not return a complete push file tree.');
  }
  const result = new Map<string, string>();
  for (const item of record['tree']) {
    const entry = asRecord(item);
    if (typeof entry?.['path'] !== 'string' || typeof entry['type'] !== 'string'
      || typeof entry['sha'] !== 'string' || typeof entry['mode'] !== 'string') {
      throw new Error('GitHub returned a malformed push file tree.');
    }
    if (entry['type'] === 'blob' || entry['type'] === 'commit') {
      result.set(entry['path'], `${entry['sha']}:${entry['mode']}`);
    }
  }
  return result;
}

/** A capped comparison cannot prove either overlap or repair scope. Include deletions and mode changes. */
export function changedPathsFromTrees(beforeBody: unknown, afterBody: unknown): readonly string[] {
  const before = blobVersionsFromGithubTree(beforeBody);
  const after = blobVersionsFromGithubTree(afterBody);
  return [...new Set([...before.keys(), ...after.keys()])]
    .filter((path) => before.get(path) !== after.get(path)).sort();
}

/** GitHub compare truncates at 300 files; complete trees preserve runtime changes beyond that cap. */
export function changedRuntimeSourcesFromTrees(
  beforeBody: unknown,
  afterBody: unknown,
): readonly ChangedRuntimeSource[] {
  const before = blobVersionsFromGithubTree(beforeBody);
  const after = blobVersionsFromGithubTree(afterBody);
  const changed: ChangedRuntimeSource[] = [];
  for (const [filename, sha] of after) {
    if (!runtimeSourcePath.test(filename)) continue;
    const previous = before.get(filename);
    if (previous !== sha) {
      changed.push({ filename, status: previous === undefined ? 'added' : 'modified' });
    }
  }
  return changed.sort((left, right) => left.filename.localeCompare(right.filename));
}
