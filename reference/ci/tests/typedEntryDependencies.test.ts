import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, normalize } from 'node:path';
import test from 'node:test';
import { load } from 'js-yaml';

/**
 * A job that runs a typed `ci/src` program whose import graph reaches an npm
 * package (zod, js-yaml, …) must install dependencies before that step, or it
 * dies with ERR_MODULE_NOT_FOUND. The validation-policy lane shipped exactly
 * that: its debt preflight gained a zod import while the job installed
 * nothing, and every PR selecting the policy lane failed its required verdict.
 */

interface Step {
  readonly name?: string;
  readonly run?: string;
  readonly with?: Readonly<Record<string, unknown>>;
  readonly 'working-directory'?: string;
}
interface Job {
  readonly steps?: readonly Step[];
  readonly defaults?: { readonly run?: { readonly 'working-directory'?: string } };
}

const importPattern = /^\s*(?:import|export)\s+(?!type\b)(?:[^'";]*?\sfrom\s+)?['"]([^'"]+)['"]/gm;
const dynamicImportPattern = /\bimport\(\s*['"]([^'"]+)['"]\s*\)/g;

/** Every package (bare specifier) the source's runtime import graph reaches. */
function reachedPackages(entry: string, seen = new Set<string>()): Set<string> {
  const packages = new Set<string>();
  if (seen.has(entry) || !existsSync(entry)) return packages;
  seen.add(entry);
  const source = readFileSync(entry, 'utf8');
  for (const pattern of [importPattern, dynamicImportPattern]) {
    for (const match of source.matchAll(pattern)) {
      const specifier = match[1];
      if (specifier === undefined || specifier.startsWith('node:')) continue;
      if (!specifier.startsWith('.')) {
        packages.add(specifier.startsWith('@') ? specifier.split('/').slice(0, 2).join('/') : specifier.split('/')[0] ?? specifier);
        continue;
      }
      for (const found of reachedPackages(normalize(join(dirname(entry), specifier)), seen)) packages.add(found);
    }
  }
  return packages;
}

/** The repository-relative `ci/` root a program path runs from, and the program itself. */
function typedEntry(text: string, workingDirectory: string): { root: string; entry: string } | undefined {
  const match = /(?:^|[\s'"])((?:\.\.\/)?(?:\.ci\/[\w-]+\/)?ci\/src\/[\w/.-]+\.ts)\b/.exec(text);
  if (match?.[1] === undefined || text.includes('${{')) return undefined;
  const entry = normalize(join(workingDirectory, match[1]));
  return { root: entry.slice(0, entry.indexOf('ci/src/')), entry };
}

/** Whether a step installs the packages a program under `root` resolves. */
function installsFor(step: Step, root: string, workingDirectory: string): boolean {
  const run = step.run ?? '';
  const prefix = /npm ci --prefix (\S+)/.exec(run)?.[1];
  if (prefix !== undefined) return normalize(join(workingDirectory, prefix)) === normalize(join(root, 'ci'));
  // A root install (or the typed installers that run one) serves a workspace-root program.
  return root === '' && (/^npm ci\b/.test(run)
    || /install(Node|WorkflowContract)Dependencies\.ts/.test(run));
}

const packageRequired = new Set(['zod', 'js-yaml', 'gagen', 'typescript', 'yaml']);

function violations(workflowPath: string): string[] {
  const workflow = load(readFileSync(workflowPath, 'utf8')) as { jobs: Record<string, Job> };
  const found: string[] = [];
  for (const [id, job] of Object.entries(workflow.jobs)) {
    const steps = job.steps ?? [];
    for (const [index, step] of steps.entries()) {
      const workingDirectory = step['working-directory'] ?? job.defaults?.run?.['working-directory'] ?? '.';
      const program = typedEntry(`${step.run ?? ''} ${JSON.stringify(step.with ?? {})}`, workingDirectory);
      if (program === undefined) continue;
      // A nested `.ci/<name>/ci/src/...` checkout is this repository's ci layer at
      // a trusted SHA; scan the same program in this tree.
      const source = program.entry.slice(program.root.length);
      const needed = [...reachedPackages(source)].filter((name) => packageRequired.has(name));
      if (needed.length === 0) continue;
      const installed = steps.slice(0, index).some((earlier) =>
        installsFor(earlier, program.root, earlier['working-directory']
          ?? job.defaults?.run?.['working-directory'] ?? '.'));
      if (!installed) found.push(`${id} / ${step.name ?? '(unnamed)'}: ${program.entry} needs ${needed.join(', ')}`);
    }
  }
  return found;
}

test('the reachability scan sees through relative imports to zod', () => {
  assert.ok(reachedPackages('ci/src/actions/debt/runDebtDependencyPreflight.ts').has('zod'));
  assert.ok(!reachedPackages('ci/src/actions/runPrValidationPolicyTests.ts').has('zod'));
});

test('PR Checks installs dependencies before every typed program that imports a package', () => {
  assert.deepEqual(violations('.github/workflows/pr-checks.yml'), []);
});

test('the validation-policy lane installs the ci package before the debt preflight', () => {
  const workflow = load(readFileSync('.github/workflows/pr-checks.yml', 'utf8')) as { jobs: Record<string, Job> };
  const steps = workflow.jobs['validation-policy']?.steps ?? [];
  const install = steps.findIndex((step) => step.run === 'npm ci --prefix ci --no-audit --no-fund --ignore-scripts');
  const preflight = steps.findIndex((step) => step.name === 'Validate debt dependency preflight');
  assert.ok(install >= 0 && install < preflight, 'typed CI dependencies must be installed first');
});

test('the iOS live tuple guard installs its typed dependencies before it runs', () => {
  // confirmCurrentPullRequest.ts reaches zod through ciEvent.ts; running it
  // before the install broke every iOS PR whose trusted base included #6153.
  const guard = violations('.github/workflows/ios-tests.yml')
    .filter((violation) => violation.startsWith('confirm-current-ios-pr /'));
  assert.deepEqual(guard, []);
});

test('the dequeued-candidate cleanup runs dependency-free from its sparse ci/src checkout', () => {
  // The workflow checks out only ci/src and installs nothing, so its program
  // must not reach zod (it once did through ciEvent.ts).
  assert.deepEqual(violations('.github/workflows/cancel-dequeued-candidate.yml'), []);
});
