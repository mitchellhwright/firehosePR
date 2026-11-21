import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { once } from 'node:events';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import test, { type TestContext } from 'node:test';
import { load } from 'js-yaml';
import { ciEventFieldSource } from '../workflows/lib/ciEvent.ts';

interface Step {
  name: string; id?: string; if?: string; run?: string;
  env?: Record<string, string>; with?: Record<string, unknown>;
}
const workflow = load(readFileSync('.github/workflows/pr-checks.yml', 'utf8')) as {
  jobs: Record<string, { steps: Step[] }>;
};
const steps = workflow.jobs['plan-pr-validation']?.steps;
assert.ok(steps);
function step(name: string): Step {
  const found = steps?.find(candidate => candidate.name === name);
  assert.ok(found, name);
  return found;
}
const plan = step('Select required validation lanes');
const actions = 'ci/src/actions';
function write(directory: string, path: string, content: string): void {
  const destination = join(directory, path);
  mkdirSync(dirname(destination), { recursive: true });
  writeFileSync(destination, content);
}
function workspace(t: TestContext): string {
  const directory = mkdtempSync(join(tmpdir(), 'example-pr-gate-bootstrap-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  cpSync('ci/src', join(directory, 'ci/src'), { recursive: true });
  symlinkSync(resolve('ci/node_modules'), join(directory, 'ci/node_modules'));
  write(directory, 'ci/package.json', '{"type":"module"}');
  return directory;
}
function command(directory: string, selected: Step): string {
  assert.ok(selected.run);
  assert.ok(!selected.run.includes('${{'), `dynamic adapter path in ${directory}`);
  return selected.run;
}
function run(directory: string, selected: Step, env: Record<string, string> = {}) {
  const rendered = command(directory, selected);
  assert.ok(rendered.startsWith('node '));
  assert.ok(!rendered.includes('${{'), 'all expressions must be resolved');
  return spawnSync(process.execPath, [rendered.slice(5)], {
    cwd: directory, env: { ...process.env, ...env }, encoding: 'utf8', timeout: 15000,
  });
}

test('trusted base gate executes typed adapters directly', () => {
  const source = step('Check out the trusted base gate scripts');
  assert.equal(source.id, 'trusted-gate-source');
  assert.equal(source.with?.ref, '${{ github.event.repository.default_branch }}');
  assert.equal(step('Install typed planner dependencies').if, undefined);
  assert.equal(plan.run, `node ${actions}/planPrValidation.ts`);
  for (const [name, action] of [
    ['Collect PR change inventory', 'collectPrChangeInventory'],
    ['Detect removed changed files', 'selectPrDeletionInventory'],
    ['Load exact-head server test runtime contracts', 'loadPrRuntimeManifest'],
    ['Explain financial calculation assurance', 'explainCalculationAssurance'],
  ] as const) {
    assert.equal(step(name).run, `node ${actions}/${action}.ts`);
  }
  assert.ok(steps.indexOf(step('Checkout trusted base workspace'))
    < steps.indexOf(step('Install typed planner dependencies')));
  assert.ok(steps.indexOf(step('Install typed planner dependencies'))
    < steps.indexOf(step('Collect PR change inventory')));
  assert.ok(!steps.some(candidate => candidate.name.includes('missing gate adapter')));
});

test('classifier has a compatible runtime and all shared modules before execution', () => {
  const classifier = step('Detect verified incremental head delta');
  assert.equal(classifier.run, 'node ci/src/actions/ios/runTrustedBaseUpdateClassifier.ts');
  assert.equal(classifier.env?.TRUSTED_CHECKOUT_PATH, '.ci/trusted-base-update');
  assert.equal(classifier.env?.BASE_SHA, step('Checkout base-update classifier').with?.ref);
  assert.ok(String(step('Check out the trusted base gate scripts').with?.['sparse-checkout']).includes('ci/src\n'));
  assert.ok(steps.indexOf(step('Setup Node for the typed planner')) < steps.indexOf(classifier));
});

test('both planners install the exact trusted classifier package before importing it', () => {
  for (const [file, job] of [['pr-checks', 'plan-pr-validation'], ['ios-tests', 'ios-change-gate']] as const) {
    const document = load(readFileSync(`.github/workflows/${file}.yml`, 'utf8')) as typeof workflow;
    const pipeline = document.jobs[job]?.steps;
    assert.ok(pipeline);
    const checkout = pipeline.find(candidate => candidate.with?.path === '.ci/trusted-base-update');
    const install = pipeline.find(candidate => candidate.name === 'Install trusted base-update classifier dependencies');
    const classifier = pipeline.find(candidate => candidate.id === 'base-update');
    assert.ok(checkout); assert.ok(install); assert.ok(classifier);
    assert.equal(install.run, 'npm ci --prefix .ci/trusted-base-update/ci --no-audit --no-fund --ignore-scripts');
    assert.equal(install.if, classifier.if, 'dependency installation must follow the same event boundary');
    assert.match(String(checkout.with?.['sparse-checkout']), /(?:^|\n)ci\n/);
    assert.ok(pipeline.indexOf(checkout) < pipeline.indexOf(install));
    assert.ok(pipeline.indexOf(install) < pipeline.indexOf(classifier));
  }
});

test('the actual classifier imports from a fresh trusted checkout only after its native install', { timeout: 45_000 }, t => {
  const directory = mkdtempSync(join(tmpdir(), 'example-classifier-deps-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const trusted = join(directory, '.ci/trusted-base-update');
  mkdirSync(trusted, { recursive: true });
  for (const path of ['ci/src', 'scripts/ci', 'ci/contracts', '.github/workflows']) {
    cpSync(path, join(trusted, path), { recursive: true });
  }
  for (const path of ['ci/package.json', 'ci/package-lock.json']) cpSync(path, join(trusted, path));
  const git = (...args: string[]) => {
    const result = spawnSync('git', ['-C', trusted, ...args], { encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    return result.stdout.trim();
  };
  git('init', '-q');
  git('-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.test',
    '-c', 'core.hooksPath=/dev/null', 'commit', '--allow-empty', '-qm', 'fixture');
  write(directory, 'event.json', JSON.stringify({ action: 'opened' }));
  const env = { ...process.env, GITHUB_WORKSPACE: directory, GITHUB_EVENT_PATH: join(directory, 'event.json'),
    GITHUB_TOKEN: '', TRUSTED_CHECKOUT_PATH: '.ci/trusted-base-update', BASE_SHA: git('rev-parse', 'HEAD') };
  const invoke = () => spawnSync(process.execPath, [resolve('ci/src/actions/ios/runTrustedBaseUpdateClassifier.ts')],
    { cwd: directory, env, encoding: 'utf8', timeout: 15_000 });
  const missing = invoke();
  assert.notEqual(missing.status, 0);
  // ESM may report either locked parser first as the import graph evolves.
  assert.match(missing.stderr, /ERR_MODULE_NOT_FOUND/);
  assert.match(missing.stderr, /Cannot find package '(?:js-yaml|zod)'/);
  const install = step('Install trusted base-update classifier dependencies');
  assert.ok(install.run);
  assert.ok(install.run.startsWith('npm '));
  const installed = spawnSync('npm', install.run.slice(4).split(' '), {
    cwd: directory, env: { ...env, npm_config_offline: 'true' }, encoding: 'utf8', timeout: 30_000,
  });
  assert.equal(installed.status, 0, `${installed.stdout}\n${installed.stderr}`);
  const ready = invoke();
  assert.equal(ready.status, 0, `${ready.stdout}\n${ready.stderr}`);
  assert.match(ready.stdout, /Trusted base-update classifier checkout/);
});

test('a failing base planner stays failed without borrowing the fallback planner', t => {
  const directory = workspace(t);
  write(directory, `${actions}/planPrValidation.ts`, 'process.exit(17);');
  write(directory, '.github/actions/plan-pr-validation/dist/index.js', 'process.exit(0);');
  assert.equal(run(directory, plan).status, 17);
});
test('a missing base planner stays failed instead of executing fallback policy', t => {
  const directory = workspace(t);
  rmSync(join(directory, `${actions}/planPrValidation.ts`));
  write(directory, '.github/actions/plan-pr-validation/dist/index.js', 'process.exit(0);');
  const result = run(directory, plan);
  assert.notEqual(result.status, 0);
});
test('the trusted base planner takes precedence over PR-head code', t => {
  const directory = workspace(t);
  write(directory, `${actions}/planPrValidation.ts`, 'process.exit(23);');
  write(directory, `pr-head/${actions}/planPrValidation.ts`, 'process.exit(0);');
  assert.equal(run(directory, plan).status, 23);
});
test('the trusted base executes the real typed summary with isolated dependencies', t => {
  const directory = workspace(t);
  const result = run(directory, step('Explain financial calculation assurance'), {
    GITHUB_STEP_SUMMARY: 'summary.md', ASSURANCE_MODE: 'shadow', ASSURANCE_PACKAGES: '[]',
    ASSURANCE_GAPS: '[]', INDEPENDENT_AUDIT_REQUIRED: 'false',
  });
  assert.equal(result.status, 0, result.stderr);
  assert.match(readFileSync(join(directory, 'summary.md'), 'utf8'), /Mode: \*\*shadow\*\*/);
});
test('deletion and runtime adapters retain their verified input boundaries', () => {
  assert.match(step('Detect removed changed files').run ?? '', /selectPrDeletionInventory\.ts$/);
  assert.equal(step('Detect removed changed files').env?.CLASSIFIER_INVENTORY_SELECTED,
    "${{ steps.inventory.outputs.classifier_inventory_selected || 'false' }}");
  assert.doesNotMatch(JSON.stringify(step('Detect removed changed files').env), /steps\.base-update\.outputs\.valid/);
  assert.equal(step('Detect removed changed files').env?.FILE_STATUS_INVENTORY_VERIFIED,
    "${{ steps.inventory.outputs.file_status_inventory_verified || 'false' }}");
  assert.match(step('Load exact-head server test runtime contracts').run ?? '', /loadPrRuntimeManifest\.ts$/);
  assert.equal(step('Load exact-head server test runtime contracts').env?.HEAD_SHA, `\${{ ${ciEventFieldSource('headSha')} }}`);
});

// The classifier runs in its own session, so killing the adapter never reaches
// it. A fixture that outlived a failed test would hold this file's pipes open
// and keep the whole `node --test` run waiting, so its lifetime is bounded.
const CLASSIFIER_LIFETIME_MS = 60_000;
const READINESS_TIMEOUT_MS = 30_000;
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  test(`classifier adapter reaps its child on ${signal}`, { timeout: 45_000 }, async t => {
    const directory = mkdtempSync(join(tmpdir(), 'example-classifier-stop-'));
    const trusted = join(directory, '.ci/trusted-base-update');
    mkdirSync(trusted, { recursive: true });
    const git = (...args: string[]) => {
      const result = spawnSync('git', ['-C', trusted, ...args], {
        encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 10_000,
      });
      const detail = `${result.stderr}${result.error?.message ?? ''}`;
      assert.equal(result.status, 0, `git ${args.join(' ')}: ${detail}`);
      return result.stdout.trim();
    };
    git('init', '-q');
    git('-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.test',
      '-c', 'core.hooksPath=/dev/null', 'commit', '--allow-empty', '-qm', 'fixture');
    write(trusted, 'ci/src/ios/controllers/baseUpdateDelta.ts',
      `console.log("READY", process.pid); setTimeout(() => {}, ${CLASSIFIER_LIFETIME_MS});`);
    const adapter = spawn(process.execPath, [resolve('ci/src/actions/ios/runTrustedBaseUpdateClassifier.ts')], {
      cwd: directory, stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, GITHUB_WORKSPACE: directory,
        TRUSTED_CHECKOUT_PATH: '.ci/trusted-base-update', BASE_SHA: git('rev-parse', 'HEAD') },
    });
    let childPid: number | undefined;
    t.after(() => {
      adapter.kill('SIGKILL');
      if (childPid !== undefined) { try { process.kill(childPid, 'SIGKILL'); } catch { /* Reaped. */ } }
      // A classifier started before readiness was seen still shares these pipes.
      adapter.stdout.destroy();
      adapter.stderr.destroy();
      rmSync(directory, { recursive: true, force: true });
    });
    const exited = once(adapter, 'exit');
    let stdout = '';
    let stderr = '';
    adapter.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString(); });
    childPid = await new Promise<number>((resolvePid, reject) => {
      const timer = setTimeout(() => {
        const output = `${stdout}${stderr}`;
        reject(new Error(`Classifier not ready within ${READINESS_TIMEOUT_MS}ms\n${output}`));
      }, READINESS_TIMEOUT_MS);
      timer.unref();
      adapter.once('error', reject);
      adapter.once('exit', () => {
        reject(new Error(`Classifier exited before readiness\n${stderr}`));
      });
      adapter.stdout.on('data', (chunk: Buffer) => {
        stdout += chunk.toString();
        const match = /READY (\d+)/.exec(stdout);
        if (match?.[1]) { clearTimeout(timer); resolvePid(Number(match[1])); }
      });
    });
    adapter.kill(signal);
    const [code] = await exited;
    assert.equal(code, signal === 'SIGINT' ? 130 : 143);
    assert.throws(() => process.kill(childPid!, 0), { code: 'ESRCH' });
  });
}

test('the trusted base runs its inventory collector without borrowing head code', t => {
  const directory = workspace(t);
  const selected = step('Collect PR change inventory');
  const output = join(directory, 'inventory-outputs');
  const deleted = join(directory, 'deleted-files');
  const result = run(directory, selected, {
    RUNNER_TEMP: directory, DELETED_FILES_INVENTORY_FILE: deleted, GITHUB_OUTPUT: output,
    EVENT_NAME: 'pull_request', CONTROLLER_BASE_UPDATE_VALID: 'true',
    CONTROLLER_BASE_UPDATE_FILES: '', CONTROLLER_BASE_UPDATE_PATCH_EQUIVALENT: 'true',
  });
  assert.equal(result.status, 0, result.stderr);
  assert.match(readFileSync(output, 'utf8'), /metadata_only=true/);
  assert.equal(readFileSync(deleted, 'utf8'), '');
  assert.equal(selected.run, `node ${actions}/collectPrChangeInventory.ts`);
});
