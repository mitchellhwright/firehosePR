import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import {
  exactHeadScriptSources,
  parseNameStatus,
  type ScriptSourceRevision,
} from '../src/exactHeadScriptSources.ts';
import { runCommand } from '../src/ios/shared/processRunner.ts';
import { derivePrValidationPlan } from '../src/prValidationPlan.ts';
import {
  affectedScriptServerTests,
  retainDeletedScriptConsumers,
  scriptConsumers,
  scriptConsumersFromSources,
  scriptValidationImpact,
  workflowOnlyScripts,
} from '../src/scriptConsumers.ts';

test('NUL name-status parsing preserves deletes and rename pairs', () => {
  assert.deepEqual(parseNameStatus('M\0scripts/a.mjs\0D\0server/tests/old.test.ts\0R100\0scripts/b.mjs\0scripts/c.mjs\0'), [
    { status: 'M', newPath: 'scripts/a.mjs' },
    { status: 'D', oldPath: 'server/tests/old.test.ts' },
    { status: 'R100', oldPath: 'scripts/b.mjs', newPath: 'scripts/c.mjs' },
  ]);
  assert.throws(() => parseNameStatus('R100\0scripts/a.mjs\0'), /renamed/);
});

test('verified head overlay includes earlier consumers and removes deleted tests', async (t) => {
  const fixture = mkdtempSync(join(tmpdir(), 'script-head-sources-'));
  t.after(() => rmSync(fixture, { recursive: true, force: true }));
  const remote = join(fixture, 'remote');
  const local = join(fixture, 'local');
  mkdirSync(remote);
  const git = (cwd: string, args: readonly string[]): string => execFileSync('git', [...args], {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
  git(remote, ['init']);
  for (const [path, content] of Object.entries({
    '.github/workflows/ci.yml': [
      'run: node scripts/entry.mjs',
      'run: node scripts/later.mjs',
      'run: node scripts/deleted.mjs',
      '',
    ].join('\n'),
    'package.json': '{"scripts":{}}',
    'scripts/tests/removed.test.mjs': 'export {};\n',
    'scripts/entry.mjs': "import './leaf.mjs';\n",
    'scripts/leaf.mjs': 'export {};\n',
    'scripts/deleted.mjs': 'export {};\n',
    'server/tests/old.test.ts': "readFileSync('scripts/leaf.mjs');\n",
    'server/tests/deleted.test.ts': "readFileSync('scripts/deleted.mjs');\n",
    'server/service.ts': "import '../scripts/later.mjs';\n",
  })) {
    mkdirSync(join(remote, path, '..'), { recursive: true });
    writeFileSync(join(remote, path), content);
  }
  git(remote, ['add', '.']);
  git(remote, ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.test', 'commit', '-m', 'base']);
  const baseSha = git(remote, ['rev-parse', 'HEAD']);
  execFileSync('git', ['clone', remote, local], { stdio: 'ignore' });
  const baseGraph = scriptConsumers(local);

  // These changes may have happened in an earlier PR commit. The current
  // incremental delta can contain only scripts/leaf.mjs; reconstruction still
  // has to see every consumer at the exact head.
  writeFileSync(join(remote, 'server/service.ts'), "import '../scripts/entry.mjs';\nimport '../scripts/later.mjs';\n");
  writeFileSync(join(remote, 'server/tests/new.test.ts'), "readFileSync('scripts/entry.mjs');\n");
  writeFileSync(join(remote, 'scripts/tests/added.test.mjs'), 'export const tested = true;\n');
  rmSync(join(remote, 'scripts/tests/removed.test.mjs'));
  writeFileSync(join(remote, 'scripts/later.mjs'), 'export {};\n');
  rmSync(join(remote, 'server/tests/old.test.ts'));
  rmSync(join(remote, 'server/tests/deleted.test.ts'));
  rmSync(join(remote, 'scripts/deleted.mjs'));
  writeFileSync(join(remote, 'scripts/leaf.mjs'), 'export const changed = true;\n');
  git(remote, ['add', '-A']);
  git(remote, ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.test', 'commit', '-m', 'head']);
  const headSha = git(remote, ['rev-parse', 'HEAD']);
  git(remote, ['update-ref', 'refs/pull/123/head', headSha]);

  const revision: ScriptSourceRevision = {
    repository: 'owner/repo',
    prNumber: '123',
    baseSha,
    headSha,
    tokens: ['test-token'],
  };
  const run: typeof runCommand = async (command, args, options) => {
    assert.equal(command, 'git');
    assert.ok(!args.some((argument) => argument.includes('test-token')));
    assert.equal(options?.env?.GIT_TERMINAL_PROMPT, '0');
    return runCommand(command, args.map((argument) =>
      argument === 'https://github.com/owner/repo.git' ? remote : argument), options);
  };
  const sources = await exactHeadScriptSources(local, revision, run);
  assert.equal(sources.get('scripts/tests/added.test.mjs'), 'export const tested = true;\n');
  assert.equal(sources.has('scripts/tests/removed.test.mjs'), false);
  const deletedScripts = ['scripts/deleted.mjs'];
  const graph = retainDeletedScriptConsumers(
    baseGraph,
    scriptConsumersFromSources(sources, deletedScripts),
    sources,
    deletedScripts,
  );
  assert.deepEqual(workflowOnlyScripts(graph), ['scripts/deleted.mjs']);
  assert.deepEqual(affectedScriptServerTests(graph, ['scripts/leaf.mjs']), ['server/tests/new.test.ts']);
  assert.deepEqual(affectedScriptServerTests(graph, deletedScripts), []);
  assert.equal(graph.get('scripts/deleted.mjs')?.some((reference) =>
    reference.consumer === 'server-test'), false);
  const deletionPlan = derivePrValidationPlan({
    changedFiles: deletedScripts,
    deletedFiles: deletedScripts,
    fileStatusAvailable: true,
    metadataOnly: false,
    packageManifestRuntimeNeutral: false,
    scriptImpact: scriptValidationImpact(graph, deletedScripts),
  }, { schema: 'example.server-test-runtimes.v1', tests: [] });
  assert.equal(deletionPlan.serverStaticRequired, false);
  assert.equal(deletionPlan.serverTestMode, 'none');
  assert.equal(deletionPlan.databaseRequired, false);
  assert.equal(sources.has('server/tests/old.test.ts'), false);
  // The application source was unchanged in the relevant portion, but the
  // newly added target now exists and must be recognized as its dependency.
  assert.equal(sources.get('scripts/later.mjs'), 'export {};\n');
  assert.equal(git(local, ['for-each-ref', '--format=%(refname)', 'refs/example-ci/']), '');

  await assert.rejects(
    exactHeadScriptSources(local, { ...revision, headSha: 'b'.repeat(40) }, run),
    /head changed/,
  );
  assert.equal(git(local, ['for-each-ref', '--format=%(refname)', 'refs/example-ci/']), '');

  symlinkSync('leaf.mjs', join(remote, 'scripts/link.mjs'));
  git(remote, ['add', 'scripts/link.mjs']);
  git(remote, ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.test', 'commit', '-m', 'unsupported source']);
  const symlinkHead = git(remote, ['rev-parse', 'HEAD']);
  git(remote, ['update-ref', 'refs/pull/123/head', symlinkHead]);
  await assert.rejects(
    exactHeadScriptSources(local, { ...revision, headSha: symlinkHead }, run),
    /not a regular Git blob/,
  );
  assert.equal(git(local, ['for-each-ref', '--format=%(refname)', 'refs/example-ci/']), '');
});

// The held child runs in its own session, so killing the reader never reaches
// it. A child that outlived a failed test would hold this file's pipes open and
// keep the whole `node --test` run waiting, so its lifetime is bounded.
// Outlast the enclosing test deadline so a missed cancellation cannot pass
// merely because the simulated child eventually exits on its own.
const HELD_CHILD_LIFETIME_MS = 120_000;
const READINESS_TIMEOUT_MS = 30_000;
// Local fixture setup is not the cancellation behavior under test. Shared CI
// runners may stall a tiny Git clone while the parallel contract suite runs.
const GIT_FIXTURE_SETUP_TIMEOUT_MS = 30_000;
for (const phase of ['read', 'cleanup'] as const) {
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  test(`exact-head source cancellation during ${phase} removes its Git ref on ${signal}`, {
    timeout: 90_000,
  }, async (t) => {
    const fixture = mkdtempSync(join(tmpdir(), 'script-head-cancel-'));
    const remote = join(fixture, 'remote');
    const local = join(fixture, 'local');
    mkdirSync(remote);
    const git = (cwd: string, args: readonly string[]): string => execFileSync('git', [...args], {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: GIT_FIXTURE_SETUP_TIMEOUT_MS,
    }).trim();
    git(remote, ['init']);
    writeFileSync(join(remote, 'package.json'), '{"scripts":{}}');
    mkdirSync(join(remote, 'scripts'));
    writeFileSync(join(remote, 'scripts/helper.mjs'), 'export {};\n');
    git(remote, ['add', '.']);
    git(remote, ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.test',
      'commit', '-m', 'base']);
    const baseSha = git(remote, ['rev-parse', 'HEAD']);
    execFileSync('git', ['clone', remote, local], {
      stdio: 'ignore', timeout: GIT_FIXTURE_SETUP_TIMEOUT_MS,
    });
    writeFileSync(join(remote, 'scripts/helper.mjs'), 'export const changed = true;\n');
    git(remote, ['add', '.']);
    git(remote, ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.test',
      'commit', '-m', 'head']);
    const headSha = git(remote, ['rev-parse', 'HEAD']);
    git(remote, ['update-ref', 'refs/pull/123/head', headSha]);
    const program = join(fixture, 'adapter.mjs');
    writeFileSync(program, `
      import { exactHeadScriptSources } from ${JSON.stringify(new URL('../src/exactHeadScriptSources.ts', import.meta.url).href)};
      import { installSignalTraps, runCommand } from ${JSON.stringify(new URL('../src/ios/shared/processRunner.ts', import.meta.url).href)};
      import { setTimeout as delay } from 'node:timers/promises';
      const cancellation = new AbortController();
      process.once('SIGINT', () => cancellation.abort());
      process.once('SIGTERM', () => cancellation.abort());
      let operation;
      let held = false;
      installSignalTraps(async () => { try { await operation; } catch {} });
      operation = exactHeadScriptSources(${JSON.stringify(local)}, ${JSON.stringify({
        repository: 'owner/repo', prNumber: '123', baseSha, headSha, tokens: ['test-token'],
      })}, async (command, args, options) => {
        const holdRead = args[0] === 'rev-parse' && String(args[1]).startsWith('refs/example-ci/');
        if (!held && (${JSON.stringify(phase)} === 'read' ? holdRead : args[0] === 'update-ref')) {
          held = true;
          return runCommand(process.execPath, ['-e',
            'console.log("READY", process.pid); setTimeout(() => {}, ${HELD_CHILD_LIFETIME_MS});']);
        }
        if (args[0] === 'update-ref') await delay(150);
        return runCommand(command, args.map(argument =>
          argument === 'https://github.com/owner/repo.git' ? ${JSON.stringify(remote)} : argument), options);
      }, cancellation.signal);
      try { await operation; } catch (error) { if (!cancellation.signal.aborted) throw error; }
    `);
    const child = spawn(process.execPath, [program], { stdio: ['ignore', 'pipe', 'pipe'] });
    let heldPid: number | undefined;
    t.after(() => {
      child.kill('SIGKILL');
      if (heldPid !== undefined) {
        try { process.kill(heldPid, 'SIGKILL'); } catch { /* Already reaped. */ }
      }
      // A held child started before readiness was seen still shares these pipes.
      child.stdout.destroy();
      child.stderr.destroy();
      rmSync(fixture, { recursive: true, force: true });
    });
    const exited = once(child, 'exit');
    let output = '';
    let stderr = '';
    child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString(); });
    heldPid = await new Promise<number>((resolve, reject) => {
      const timer = setTimeout(() => {
        const detail = `within ${READINESS_TIMEOUT_MS}ms\n${output}${stderr}`;
        reject(new Error(`Exact-head reader not ready ${detail}`));
      }, READINESS_TIMEOUT_MS);
      timer.unref();
      child.once('error', reject);
      child.once('exit', () => {
        reject(new Error(`Exact-head reader exited before readiness\n${stderr}`));
      });
      child.stdout.on('data', (chunk: Buffer) => {
        output += chunk.toString();
        const match = /READY (\d+)/.exec(output);
        if (match?.[1]) { clearTimeout(timer); resolve(Number(match[1])); }
      });
    });
    assert.match(git(local, ['for-each-ref', '--format=%(refname)', 'refs/example-ci/']),
      /script-sources-/);
    child.kill(signal);
    const [code] = await exited;
    assert.equal(code, signal === 'SIGINT' ? 130 : 143);
    assert.equal(git(local, ['for-each-ref', '--format=%(refname)', 'refs/example-ci/']), '');
  });
}
}

test('exact-head source CLI is TypeScript and owns signal-aware cleanup', () => {
  const source = fileURLToPath(new URL('../src/actions/planPrValidation.ts', import.meta.url));
  const contents = execFileSync(process.execPath, ['-e',
    `process.stdout.write(require('node:fs').readFileSync(${JSON.stringify(source)}, 'utf8'))`],
  { encoding: 'utf8' });
  assert.match(contents, /installSignalTraps/);
  assert.match(contents, /cancellation\.signal/);
});
