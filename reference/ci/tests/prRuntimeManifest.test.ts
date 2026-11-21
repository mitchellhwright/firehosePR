import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { once } from 'node:events';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import test from 'node:test';
import { loadRuntimeManifest, readRuntimeManifestFromGithub, readRuntimeManifestFromGit,
  runtimeManifestPath, type RuntimeManifestPorts, type RuntimeManifestRevision,
} from '../src/prRuntimeManifest.ts';
import type { GithubReader, GithubResponse } from '../src/ios/shared/githubRest.ts';
import { runCommand } from '../src/ios/shared/processRunner.ts';

const manifest = JSON.stringify({ schema: 'example.server-test-runtimes.v1', tests: [] });
const revision: RuntimeManifestRevision = { repository: 'owner/repo', prNumber: '123', headSha: 'a'.repeat(40), tokens: ['test-token'] };
const options = { metadataOnly: false, revision, changedFiles: [], deletedFiles: [] };
const unreachable = (): never => { throw new Error('Unexpected port call'); };
const ports: RuntimeManifestPorts = { fromGithub: unreachable, fromGit: unreachable, fromBase: unreachable };
const response = (status: number, body?: unknown): GithubResponse => ({ status, statusLabel: String(status), body });
const contents = (text = manifest) => ({ type: 'file', encoding: 'base64', size: Buffer.byteLength(text), content: Buffer.from(text).toString('base64') });
function readerFor(...responses: GithubResponse[]): { read: GithubReader; urls: string[] } {
  const urls: string[] = [];
  return { urls, read: async (url) => {
    urls.push(url);
    const answer = responses.shift();
    assert.ok(answer, 'unexpected API request');
    return answer;
  } };
}

test('metadata-only planning uses the base without network or credentials', async () => {
  assert.deepEqual(await loadRuntimeManifest({ ...options, metadataOnly: true, revision: undefined },
    { ...ports, fromBase: () => manifest }), { source: 'metadata-base', contents: manifest });
});
test('head content is validated and does not read the base or run Git', async () => {
  assert.deepEqual(await loadRuntimeManifest(options, { ...ports,
    fromGithub: async () => ({ source: 'github', contents: manifest }),
  }), { source: 'github', contents: manifest });
});
for (const reason of ['missing', 'quota', 'transient'] as const) {
  test(`${reason} API response uses Git content rather than the base`, async () => {
    const selected = await loadRuntimeManifest(options, { ...ports,
      fromGithub: async () => ({ source: 'git-required', reason }), fromGit: async () => manifest,
    });
    assert.equal(selected.source, 'git');
  });
}
for (const field of ['changedFiles', 'deletedFiles'] as const) {
  test(`a missing manifest in ${field} cannot borrow the base contract`, async () => {
    await assert.rejects(loadRuntimeManifest({ ...options, [field]: [runtimeManifestPath] }, { ...ports,
      fromGithub: async () => ({ source: 'git-required', reason: 'missing' }), fromGit: async () => null,
    }), /changed or deleted/);
  });
}
test('a legacy head may use the untouched base only after Git proves absence', async () => {
  const selected = await loadRuntimeManifest(options, { ...ports,
    fromGithub: async () => ({ source: 'git-required', reason: 'missing' }), fromGit: async () => null,
    fromBase: () => manifest,
  });
  assert.equal(selected.source, 'legacy-base');
});
for (const content of ['[]', '{}', '{', JSON.stringify({ schema: 'example.server-test-runtimes.v1', tests: [], extra: true }), ' '.repeat(131_073)]) {
  test(`rejects malformed, unsupported, or oversized contract (${content.length} bytes)`, async () => {
    await assert.rejects(loadRuntimeManifest(options, { ...ports,
      fromGithub: async () => ({ source: 'github', contents: content }),
    }));
  });
}
test('API fetch verifies the live head and pins the content request to its immutable SHA', async () => {
  const reader = readerFor(response(200, { head: { sha: revision.headSha } }), response(200, contents()));
  assert.deepEqual(await readRuntimeManifestFromGithub(revision, reader.read), { source: 'github', contents: manifest });
  assert.equal(reader.urls[1], `https://api.github.com/repos/owner/repo/contents/${runtimeManifestPath}?ref=${revision.headSha}`);
});
test('API head movement or malformed metadata stops before fetching content', async () => {
  for (const body of [{ head: { sha: 'b'.repeat(40) } }, {}]) {
    const reader = readerFor(response(200, body));
    await assert.rejects(readRuntimeManifestFromGithub(revision, reader.read));
    assert.equal(reader.urls.length, 1);
  }
});
for (const status of [403, 429, 404, 500, 502, 503]) {
  test(`HTTP ${status} admits Git fallback at either read`, async () => {
    for (const responses of [[response(status)], [response(200, { head: { sha: revision.headSha } }), response(status)]]) {
      const result = await readRuntimeManifestFromGithub(revision, readerFor(...responses).read);
      assert.equal(result.source, 'git-required');
    }
  });
}
test('unexpected HTTP and malformed contents fail without a permissive fallback', async () => {
  await assert.rejects(readRuntimeManifestFromGithub(revision, readerFor(response(418)).read), /HTTP 418/);
  for (const body of [{ ...contents(), size: 1 }, { ...contents(), content: '%%%INVALID' }, { ...contents(), encoding: 'none' }]) {
    await assert.rejects(readRuntimeManifestFromGithub(revision,
      readerFor(response(200, { head: { sha: revision.headSha } }), response(200, body)).read));
  }
});

for (const scenario of ['present', 'missing', 'moved', 'oversized'] as const) {
  test(`real Git fallback handles ${scenario} and removes its temporary ref`, async (t) => {
    const root = mkdtempSync(join(tmpdir(), 'pr-runtime-git-'));
    t.after(() => rmSync(root, { recursive: true, force: true }));
    const remote = join(root, 'remote');
    const local = join(root, 'local');
    mkdirSync(remote); mkdirSync(local);
    const git = (cwd: string, args: string[]): string => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
    git(remote, ['init']); git(local, ['init']);
    mkdirSync(join(remote, 'ci/contracts'), { recursive: true });
    if (scenario !== 'missing') writeFileSync(join(remote, runtimeManifestPath), scenario === 'oversized' ? ' '.repeat(131_073) : manifest);
    git(remote, ['add', '.']);
    git(remote, ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.test', 'commit', '--allow-empty', '-m', 'fixture']);
    const sha = git(remote, ['rev-parse', 'HEAD']);
    git(remote, ['update-ref', 'refs/pull/123/head', sha]);
    const run: typeof runCommand = async (command, args, config) => {
      assert.equal(command, 'git');
      assert.ok(!args.some((arg) => arg.includes('test-token')));
      assert.equal(config?.env?.GIT_TERMINAL_PROMPT, '0');
      return runCommand(command, args.map((arg) => arg === 'https://github.com/owner/repo.git' ? remote : arg), { ...config, cwd: local });
    };
    const result = readRuntimeManifestFromGit({ ...revision, headSha: scenario === 'moved' ? 'b'.repeat(40) : sha }, run);
    if (scenario === 'moved' || scenario === 'oversized') await assert.rejects(result, scenario === 'moved' ? /head changed/ : /too large/);
    else assert.equal(await result, scenario === 'missing' ? null : manifest);
    assert.equal(git(local, ['for-each-ref', '--format=%(refname)', 'refs/example-ci/']), '');
  });
}

// The held child runs in its own session, so killing the reader never reaches
// it. A child that outlived a failed test would hold this file's pipes open and
// keep the whole `node --test` run waiting, so its lifetime is bounded.
const HELD_CHILD_LIFETIME_MS = 60_000;
const READINESS_TIMEOUT_MS = 30_000;
for (const phase of ['read', 'cleanup'] as const) {
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  test(`runtime cancellation during ${phase} awaits deletion of its real Git ref on ${signal}`, {
    timeout: 45_000,
  }, async (t) => {
    const root = mkdtempSync(join(tmpdir(), 'runtime-cancel-'));
    const remote = join(root, 'remote');
    const local = join(root, 'local');
    mkdirSync(remote); mkdirSync(local);
    const git = (cwd: string, args: string[]): string => execFileSync('git', args, {
      cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 10_000,
    }).trim();
    git(remote, ['init']); git(local, ['init']);
    git(remote, ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.test', 'commit', '--allow-empty', '-m', 'fixture']);
    const sha = git(remote, ['rev-parse', 'HEAD']);
    git(remote, ['update-ref', 'refs/pull/123/head', sha]);
    const program = join(root, 'adapter.mjs');
    writeFileSync(program, `
      import { readRuntimeManifestFromGit } from ${JSON.stringify(new URL('../src/prRuntimeManifest.ts', import.meta.url).href)};
      import { runCommand, installSignalTraps } from ${JSON.stringify(new URL('../src/ios/shared/processRunner.ts', import.meta.url).href)};
      import { setTimeout as delay } from 'node:timers/promises';
      const cancellation = new AbortController();
      process.once('SIGINT', () => cancellation.abort());
      process.once('SIGTERM', () => cancellation.abort());
      let operation;
      let held = false;
      installSignalTraps(async () => { try { await operation; } catch {} });
      operation = readRuntimeManifestFromGit(${JSON.stringify({ ...revision, headSha: sha })}, async (command, args, options) => {
        if (!held && args[0] === ${JSON.stringify(phase === 'read' ? 'rev-parse' : 'update-ref')}) {
          // Hold the selected tracked child only once; cleanup must retry after it is reaped.
          held = true;
          return runCommand(process.execPath, ['-e',
            'console.log("READY", process.pid); setTimeout(() => {}, ${HELD_CHILD_LIFETIME_MS});']);
        }
        if (args[0] === 'update-ref') await delay(150);
        return runCommand(command, args.map(arg => arg === 'https://github.com/owner/repo.git' ? ${JSON.stringify(remote)} : arg), { ...options, cwd: ${JSON.stringify(local)} });
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
      rmSync(root, { recursive: true, force: true });
    });
    const exited = once(child, 'exit');
    let output = '';
    let stderr = '';
    child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString(); });
    heldPid = await new Promise<number>((resolve, reject) => {
      const timer = setTimeout(() => {
        const detail = `${output}${stderr}`;
        reject(new Error(`Runtime reader not ready within ${READINESS_TIMEOUT_MS}ms\n${detail}`));
      }, READINESS_TIMEOUT_MS);
      timer.unref();
      child.once('error', reject);
      child.once('exit', () => {
        reject(new Error(`Runtime reader exited before readiness\n${stderr}`));
      });
      child.stdout.on('data', (chunk: Buffer) => {
        output += chunk.toString();
        const match = /READY (\d+)/.exec(output);
        if (match?.[1]) { clearTimeout(timer); resolve(Number(match[1])); }
      });
    });
    assert.match(git(local, ['for-each-ref', '--format=%(refname)', 'refs/example-ci/']), /runtime-contract-/);
    child.kill(signal);
    const [code] = await exited;
    assert.equal(code, signal === 'SIGINT' ? 130 : 143);
    assert.equal(git(local, ['for-each-ref', '--format=%(refname)', 'refs/example-ci/']), '');
  });
}
}

test('runtime CLI copies a validated metadata contract without PR credentials or inventory reads', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'runtime-metadata-cli-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, 'ci/contracts'), { recursive: true });
  writeFileSync(join(root, runtimeManifestPath), manifest);
  const output = join(root, 'output.json');
  const stdout = execFileSync(process.execPath, [fileURLToPath(new URL('../src/actions/loadPrRuntimeManifest.ts', import.meta.url))], {
    cwd: root, encoding: 'utf8', timeout: 10_000,
    env: { ...process.env, METADATA_ONLY: 'true', CHANGED_FILES_FILE: 'absent-changes', DELETED_FILES_FILE: 'absent-deletions',
      BASE_REPOSITORY: '', HEAD_SHA: '', PR_NUMBER: '', GITHUB_TOKEN: '', GITHUB_FALLBACK_TOKEN: '',
      RUNTIME_CONTRACT_PATH: runtimeManifestPath, RUNTIME_CONTRACT_OUTPUT: output,
    },
  });
  assert.equal(readFileSync(output, 'utf8'), manifest);
  assert.match(stdout, /metadata-base/);
});

test('a merge queue candidate is re-verified through its queue ref, not a pull request', async () => {
  const queueRef = `refs/heads/gh-readonly-queue/develop/pr-123-${'b'.repeat(40)}`;
  const queued = { ...revision, prNumber: '', queueRef };
  const live = readerFor(response(200, { object: { sha: revision.headSha } }), response(200, contents()));
  assert.deepEqual(await readRuntimeManifestFromGithub(queued, live.read), { source: 'github', contents: manifest });
  assert.deepEqual(live.urls, [
    `https://api.github.com/repos/owner/repo/git/ref/heads/gh-readonly-queue/develop/pr-123-${'b'.repeat(40)}`,
    `https://api.github.com/repos/owner/repo/contents/${runtimeManifestPath}?ref=${revision.headSha}`,
  ]);
  const moved = readerFor(response(200, { object: { sha: 'c'.repeat(40) } }));
  await assert.rejects(readRuntimeManifestFromGithub(queued, moved.read), /Merge queue candidate changed/);
  await assert.rejects(readRuntimeManifestFromGithub({ ...queued, prNumber: '123' }, moved.read), /not both/);
});
