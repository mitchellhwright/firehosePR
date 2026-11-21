import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, normalize } from 'node:path';
import test from 'node:test';
import { load } from 'js-yaml';
import { definitions } from '../workflows/all.ts';
import { RUNNER_NPM_CACHE_ENV } from '../workflows/lib/model.ts';
import { STEP_ACTION_ENTRY_INPUT, STEP_ACTION_SCRIPT_INPUT } from '../workflows/lib/stepActionContract.ts';

/**
 * Self-hosted listeners that share a host run as the same user, so without an
 * override they share `~/.npm`. Merge-queue run 36365309499 lost its chat-plaid
 * lane on t-runner-2 to `EEXIST: file already exists, mkdir
 * '/home/example/.npm/_cacache/index-v5/01/9d'` while tg-1, on the same Mac
 * and user, installed at the same time. A job's `runs-on` is usually an
 * expression resolved at run time, so any job that installs packages may land
 * on a shared host: every one of them must see a cache owned by its runner.
 */

type Env = Readonly<Record<string, unknown>>;
interface Step {
  readonly name?: string;
  readonly run?: string;
  readonly with?: Readonly<Record<string, unknown>>;
  readonly env?: Env;
}
interface Job {
  readonly env?: Env;
  readonly steps?: readonly Step[];
}
interface Workflow {
  readonly env?: Env;
  readonly jobs: Readonly<Record<string, Job>>;
}

const installCommand = /\bnpm\s+(?:ci|install|i)\b/;
const relativeImport = /^\s*(?:import|export)\s+(?!type\b)(?:[^'";]*?\sfrom\s+)?['"](\.[^'"]+)['"]/gm;

/** Whether a typed program, through its relative imports, spawns `npm ci` or `npm install`. */
function sourceInstalls(entry: string, seen = new Set<string>()): boolean {
  if (seen.has(entry) || !existsSync(entry)) return false;
  seen.add(entry);
  const source = readFileSync(entry, 'utf8');
  if (/'npm'/.test(source) && /\[\s*'(?:ci|install)'\s*[,\]]/.test(source)) return true;
  for (const match of source.matchAll(relativeImport)) {
    const specifier = match[1];
    if (specifier !== undefined && sourceInstalls(normalize(join(dirname(entry), specifier)), seen)) return true;
  }
  return false;
}

function stepInstalls(step: Step): boolean {
  const run = step.run ?? '';
  if (installCommand.test(run)) return true;
  // `node ci/src/…ts` and a trusted checkout's `.ci/<name>/ci/src/…ts` run this tree's programs.
  for (const match of run.matchAll(/\bci\/src\/[\w/.-]+\.ts\b/g)) {
    if (sourceInstalls(match[0])) return true;
  }
  const entry = step.with?.[STEP_ACTION_ENTRY_INPUT];
  if (typeof entry === 'string' && sourceInstalls(entry)) return true;
  const script = step.with?.[STEP_ACTION_SCRIPT_INPUT];
  return typeof script === 'string' && existsSync(script) && installCommand.test(readFileSync(script, 'utf8'));
}

function effectiveCache(workflow: Workflow, job: Job, step: Step): unknown {
  return step.env?.['npm_config_cache'] ?? job.env?.['npm_config_cache'] ?? workflow.env?.['npm_config_cache'];
}

interface InstallingStep {
  readonly where: string;
  readonly cache: unknown;
}

function installingSteps(path: string): InstallingStep[] {
  const workflow = load(readFileSync(path, 'utf8')) as Workflow;
  const found: InstallingStep[] = [];
  for (const [id, job] of Object.entries(workflow.jobs)) {
    for (const step of job.steps ?? []) {
      if (!stepInstalls(step)) continue;
      found.push({ where: `${path} ${id} / ${step.name ?? '(unnamed)'}`, cache: effectiveCache(workflow, job, step) });
    }
  }
  return found;
}

const allInstallingSteps = definitions.flatMap((definition) => installingSteps(definition.config.path));

test('the scan finds the installs that share a host', () => {
  const where = allInstallingSteps.map((step) => step.where);
  for (const expected of [
    '.github/workflows/ios-tests.yml chat-plaid-e2e /',
    '.github/workflows/trusted-production-onboarding-e2e.yml production-onboarding-e2e /',
    '.github/workflows/pr-checks.yml ',
    '.github/workflows/node-modules-cache.yml ',
    '.github/workflows/refresh-pr-ci-after-base-edit.yml ',
  ]) {
    assert.ok(where.some((line) => line.startsWith(expected)), `expected an npm install under ${expected}`);
  }
  assert.ok(sourceInstalls('ci/src/actions/installNodeDependencies.ts'));
  assert.ok(sourceInstalls('ci/src/actions/installCiPackageDependencies.ts'));
  assert.ok(sourceInstalls('ci/src/actions/ios/ensureLaneDevBackend.ts'));
  assert.ok(!sourceInstalls('ci/src/actions/ios/prepareChatPlaidE2eUser.ts'));
});

test('every step that installs npm packages uses its runner\'s own npm cache', () => {
  const shared = allInstallingSteps.filter((step) => step.cache !== RUNNER_NPM_CACHE_ENV.npm_config_cache);
  assert.deepEqual(
    shared.map((step) => `${step.where}: npm_config_cache=${JSON.stringify(step.cache)}`),
    [],
    'these installs would share the host user\'s ~/.npm with every other listener on the host',
  );
});

test('npm resolves the cache under each runner\'s tool cache', () => {
  const root = mkdtempSync(join(tmpdir(), 'npm-cache-isolation-'));
  try {
    const cacheFor = (runner: string): string => {
      const result = spawnSync('npm', ['config', 'get', 'cache'], {
        cwd: root,
        encoding: 'utf8',
        env: {
          PATH: process.env['PATH'],
          HOME: root,
          RUNNER_TOOL_CACHE: join(root, runner, '_work', '_tool'),
          ...RUNNER_NPM_CACHE_ENV,
        },
      });
      assert.equal(result.status, 0, result.stderr);
      return result.stdout.trim();
    };
    assert.equal(cacheFor('t-runner-2'), join(root, 't-runner-2', '_work', '_tool', 'npm-cache'));
    assert.equal(cacheFor('tg-1'), join(root, 'tg-1', '_work', '_tool', 'npm-cache'));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
