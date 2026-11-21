import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { execFileSync, spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import test from 'node:test';
import { load } from 'js-yaml';
import {
  completeLinuxShardReceipt, createLinuxShardSnapshot, encodeLinuxShardReceiptLog,
  linuxShardReceiptInputPaths, linuxShardReceiptLogPrefix, parseLinuxShardReceiptLog,
  linuxShardReceiptSchema, type LinuxShardContext,
} from '../src/linuxShardReceipt.ts';
import { linuxServerShardCommand } from '../src/linuxServerShard.ts';
import { ciEventCondition } from '../workflows/lib/ciEvent.ts';

const context: LinuxShardContext = {
  repository: 'owner/repo', headRepository: 'owner/repo', prNumber: 42,
  baseSha: 'a'.repeat(40), headSha: 'b'.repeat(40), expectedMergeSha: 'c'.repeat(40),
  runId: 100, runAttempt: 1, workflowRef: 'owner/repo/.github/workflows/pr-checks.yml@refs/pull/42/merge',
  workflowSha: 'c'.repeat(40), job: 'server-tests', shard: 1,
};
const runtime = {
  node: 'v26.5.0', npm: '11.0.0', vitest: '5.0.0', platform: 'linux', arch: 'x64', kernel: '6.8',
  runnerOs: 'Linux', runnerArch: 'X64', runnerEnvironment: 'github-hosted',
  imageOs: 'ubuntu24', imageVersion: '20260922.1', ci: 'true',
  nodeEnv: '', timezone: '', nodeOptions: '', envFile: '',
};
function inputs() {
  return {
    context, runtime, mergeSha: context.expectedMergeSha, treeSha: 'd'.repeat(40),
    parents: [context.baseSha, context.headSha],
    files: new Map(linuxShardReceiptInputPaths.map(path => [path, `contents of ${path}`])),
  };
}

test('receipt binds merge tree, PR tuple, attempt, shard and native command', () => {
  const snapshot = createLinuxShardSnapshot(inputs());
  const receipt = completeLinuxShardReceipt(snapshot, snapshot, 'success');
  assert.equal(receipt.schema, 'example.linux-server-shard-receipt.v1');
  assert.equal(receipt.context.runAttempt, 1);
  assert.equal(receipt.mergeSha, context.expectedMergeSha);
  assert.equal(receipt.treeSha, 'd'.repeat(40));
  assert.equal(receipt.command, linuxServerShardCommand(1));
  assert.equal(receipt.files.length, linuxShardReceiptInputPaths.length);
  assert.match(receipt.executionDigest, /^[a-f0-9]{64}$/);
  assert.equal(linuxShardReceiptSchema.safeParse({ ...receipt, reuse: true }).success, false);
});

test('job-log receipt roundtrips and rejects missing, duplicated, or malformed markers', () => {
  const snapshot = createLinuxShardSnapshot(inputs());
  const receipt = completeLinuxShardReceipt(snapshot, snapshot, 'success');
  const marker = encodeLinuxShardReceiptLog(receipt);
  assert.ok(marker.startsWith(linuxShardReceiptLogPrefix));
  assert.deepEqual(parseLinuxShardReceiptLog(`2026-09-23T03:01:20Z ${marker}\n`), receipt);
  assert.throws(() => parseLinuxShardReceiptLog('no receipt'), /exactly one/);
  assert.throws(() => parseLinuxShardReceiptLog(`${marker}\n${marker}`), /exactly one/);
  assert.throws(() => parseLinuxShardReceiptLog(`${linuxShardReceiptLogPrefix}not+base64`), /encoding/);
});

test('merge tuple, incomplete fingerprints and selected external env files fail closed', () => {
  const value = inputs();
  for (const parents of [[context.headSha, context.baseSha], [context.baseSha],
    [context.baseSha, 'f'.repeat(40)]]) {
    assert.throws(() => createLinuxShardSnapshot({ ...value, parents }), /PR tuple/);
  }
  assert.throws(() => createLinuxShardSnapshot({ ...value, mergeSha: 'f'.repeat(40) }), /PR tuple/);
  assert.throws(() => createLinuxShardSnapshot({ ...value, files: new Map() }), /Missing shard/);
  assert.throws(() => createLinuxShardSnapshot({ ...value, runtime: { ...runtime, envFile: '.env' } }));
  assert.throws(() => createLinuxShardSnapshot({ ...value, context: { ...context, shard: 5 } }));
});

test('source tree, config, lockfile, command shard and runtime alter input fingerprints', () => {
  const value = inputs();
  const original = createLinuxShardSnapshot(value);
  for (const path of linuxShardReceiptInputPaths) {
    const files = new Map(value.files).set(path, 'changed');
    assert.notEqual(createLinuxShardSnapshot({ ...value, files }).executionDigest, original.executionDigest, path);
  }
  assert.notEqual(createLinuxShardSnapshot({ ...value, treeSha: 'e'.repeat(40) }).executionDigest, original.executionDigest);
  assert.notEqual(createLinuxShardSnapshot({ ...value, runtime: { ...runtime, node: 'v27.0.0' } }).executionDigest, original.executionDigest);
  assert.notEqual(createLinuxShardSnapshot({ ...value, context: { ...context, shard: 2 } }).executionDigest, original.executionDigest);
  // Attempt identity is provenance, not an execution input; still enforced by completion.
  const retry = createLinuxShardSnapshot({ ...value, context: { ...context, runAttempt: 2 } });
  assert.equal(retry.executionDigest, original.executionDigest);
  assert.throws(() => completeLinuxShardReceipt(original, retry, 'success'), /changed/);
});

test('completion rejects failed/skipped tests, stale snapshots and input changes', () => {
  const initial = createLinuxShardSnapshot(inputs());
  for (const result of ['failure', 'cancelled', 'skipped', '']) {
    assert.throws(() => completeLinuxShardReceipt(initial, initial, result), /cannot produce/);
  }
  const changed = createLinuxShardSnapshot({ ...inputs(), runtime: { ...runtime, vitest: '5.1.0' } });
  assert.throws(() => completeLinuxShardReceipt(initial, changed, 'success'), /changed/);
  assert.throws(() => completeLinuxShardReceipt({}, initial, 'success'));
});

interface Step {
  readonly id?: string; readonly name?: string; readonly run?: string; readonly if?: string;
  readonly 'continue-on-error'?: boolean;
  readonly uses?: string; readonly with?: Readonly<Record<string, unknown>>;
  readonly env?: Readonly<Record<string, unknown>>;
}
interface Workflow {
  readonly jobs: Readonly<Record<string, {
    readonly strategy?: { readonly matrix?: { readonly shard?: readonly number[] } };
    readonly steps: readonly Step[];
  }>>;
}

test('native matrix and aggregate remain intact; receipts follow successful native shards', () => {
  const workflow = load(readFileSync('.github/workflows/pr-checks.yml', 'utf8')) as Workflow;
  const job = workflow.jobs['server-tests'];
  assert.ok(job);
  assert.deepEqual(job.strategy?.matrix?.shard, [1, 2, 3, 4]);
  assert.equal(job.steps.find(step => step.name === 'Checkout the workflow revision')
    ?.with?.['fetch-depth'], 2);
  const before = job.steps.findIndex(step => step.name === 'Capture server shard execution inputs');
  const native = job.steps.findIndex(step => step.id === 'native-shard');
  const after = job.steps.findIndex(step => step.name === 'Record successful server shard receipt');
  assert.ok(before < native && native < after);
  assert.equal(job.steps[native]?.run, linuxServerShardCommand('${{ matrix.shard }}'));
  assert.match(job.steps[after]?.if ?? '', /steps.native-shard.outcome == 'success'/);
  assert.equal(job.steps.some(step => step.name === 'Upload server shard receipt'), false);
  assert.equal(job.steps.some(step => step.uses?.includes('upload-artifact')), false);
  const verdict = workflow.jobs.validate?.steps.find(step => step.run === 'node ci/src/actions/requireSelectedValidationLanes.ts');
  assert.equal(verdict?.env?.SERVER_TESTS, '${{ needs.server-tests.result }}');
});


test('capture reads both shallow merge parents and rejects dirty or stale checkouts', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'linux-shard-receipt-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const repo = join(root, 'source');
  const clone = join(root, 'shallow');
  mkdirSync(repo);
  const git = (cwd: string, ...args: string[]): string => execFileSync('git', [
    '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.test', ...args,
  ], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  git(repo, 'init', '--initial-branch=base');
  for (const path of linuxShardReceiptInputPaths) {
    mkdirSync(join(repo, path, '..'), { recursive: true });
    writeFileSync(join(repo, path), `fixture ${path}\n`);
  }
  git(repo, 'add', '.');
  git(repo, 'commit', '-m', 'initial');
  git(repo, 'checkout', '-b', 'feature');
  writeFileSync(join(repo, 'feature.txt'), 'feature');
  git(repo, 'add', '.');
  git(repo, 'commit', '-m', 'feature');
  const headSha = git(repo, 'rev-parse', 'HEAD');
  git(repo, 'checkout', 'base');
  writeFileSync(join(repo, 'base.txt'), 'base');
  git(repo, 'add', '.');
  git(repo, 'commit', '-m', 'base');
  const baseSha = git(repo, 'rev-parse', 'HEAD');
  git(repo, 'merge', '--no-ff', '--no-edit', 'feature');
  const expectedMergeSha = git(repo, 'rev-parse', 'HEAD');
  git(root, 'clone', '--depth=1', pathToFileURL(repo).href, clone);
  mkdirSync(join(clone, 'node_modules/vitest'), { recursive: true });
  writeFileSync(join(clone, 'node_modules/vitest/package.json'), '{"version":"5.0.0"}');
  assert.equal(git(clone, 'rev-parse', '--is-shallow-repository'), 'true');
  const captureModule = pathToFileURL(resolve('ci/src/linuxShardReceiptCapture.ts')).href;
  const observed = { ...context, baseSha, headSha, expectedMergeSha };
  const capture = (value: LinuxShardContext) => spawnSync(process.execPath, ['--input-type=module', '-e', `
    import { captureLinuxShardSnapshot } from ${JSON.stringify(captureModule)};
    // The fixture exercises Linux metadata validation on macOS without running product tests.
    Object.defineProperty(process, 'platform', { value: 'linux' });
    console.log(JSON.stringify(await captureLinuxShardSnapshot(${JSON.stringify(value)})));
  `], {
    cwd: clone, encoding: 'utf8',
    env: { ...process.env, RUNNER_OS: 'Linux', RUNNER_ARCH: 'X64', RUNNER_ENVIRONMENT: 'github-hosted',
      CI: 'true', ENV_FILE: '', NODE_OPTIONS: '' },
  });
  const successful = capture(observed);
  assert.equal(successful.status, 0, successful.stderr);
  const result: unknown = JSON.parse(successful.stdout);
  assert.equal(typeof result, 'object');
  assert.match(successful.stdout, new RegExp(expectedMergeSha));
  const stale = capture({ ...observed, headSha: 'f'.repeat(40) });
  assert.notEqual(stale.status, 0);
  assert.match(stale.stderr, /does not match the event PR tuple/);
  writeFileSync(join(clone, 'server/vitest.config.ts'), 'changed after checkout');
  const dirty = capture(observed);
  assert.notEqual(dirty.status, 0);
  assert.match(dirty.stderr, /Tracked checkout is dirty/);
});


test('missing optional runtime provenance is explicit and grants no extra receipt fields', () => {
  const snapshot = createLinuxShardSnapshot({ ...inputs(),
    context: { ...context, workflowSha: null },
    runtime: { ...runtime, runnerEnvironment: 'unknown', imageOs: '', imageVersion: '' },
  });
  assert.equal(snapshot.context.workflowSha, null);
  assert.equal(snapshot.runtime.runnerEnvironment, 'unknown');
});

test('generated non-gating telemetry preserves native outcome and blocks recording on capture failure', () => {
  const workflow = load(readFileSync('.github/workflows/pr-checks.yml', 'utf8')) as Workflow;
  const steps = workflow.jobs['server-tests']?.steps;
  assert.ok(steps);
  const names = ['Capture server shard execution inputs', 'Run server test shard',
    'Record successful server shard receipt'];
  const observedSteps = names.map(name => {
    const step = steps.find(candidate => candidate.name === name);
    assert.ok(step);
    return step;
  });
  const simulate = (outcomes: readonly ('success' | 'failure')[]) => {
    let jobSuccess = true;
    let recorded = false;
    const executed: string[] = [];
    const observed = new Map<string, string>();
    for (const [index, step] of observedSteps.entries()) {
      // These are the documented GitHub outcome/conclusion semantics applied to the generated YAML.
      const selected = (step.if ?? 'success()').split(' && ').every(condition => {
        if (condition === 'success()') return jobSuccess;
        // The fixture models a pull_request run; queue candidates record no receipt.
        if (condition === ciEventCondition('pullRequest')) return true;
        const match = /^steps\.([a-z-]+)\.outcome == 'success'$/.exec(condition);
        assert.ok(match?.[1], `Unsupported condition in fixture: ${condition}`);
        return observed.get(match[1]) === 'success';
      });
      if (!selected) continue;
      executed.push(step.name ?? '');
      const outcome = outcomes[index] ?? 'success';
      if (step.id) observed.set(step.id, outcome);
      if (outcome === 'failure' && step['continue-on-error'] !== true) jobSuccess = false;
      if (step.name === 'Record successful server shard receipt' && outcome === 'success') recorded = true;
    }
    return { jobSuccess, recorded, executed };
  };
  for (const outcomes of [
    ['failure', 'success', 'success'],
    ['success', 'success', 'failure'],
  ] as const) {
    const result = simulate(outcomes);
    assert.equal(result.jobSuccess, true);
    assert.equal(result.recorded, false);
    assert.ok(result.executed.includes('Run server test shard'));
  }
  assert.deepEqual(simulate(['success', 'failure', 'success']), {
    jobSuccess: false, recorded: false,
    executed: ['Capture server shard execution inputs', 'Run server test shard'],
  });
  assert.equal(simulate(['success', 'success', 'success']).recorded, true);
  assert.equal(observedSteps[0]?.env?.RECEIPT_WORKFLOW_SHA, '${{ github.workflow_sha }}');
  assert.equal(observedSteps[0]?.env?.RECEIPT_RUNNER_ENVIRONMENT, '${{ runner.environment }}');
});
