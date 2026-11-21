import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { ensurePolicyHistory } from '../src/actions/debt/ensurePolicyHistory.ts';

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

test('policy history fetch restores candidate ancestry without fetching unrelated refs', async (context) => {
  const directory = mkdtempSync(join(tmpdir(), 'example-policy-history-'));
  context.after(() => rmSync(directory, { recursive: true, force: true }));
  const source = join(directory, 'source');
  const remote = join(directory, 'remote.git');
  const checkout = join(directory, 'checkout');
  git(directory, 'init', '--bare', remote);
  git(directory, 'init', source);
  git(source, 'config', 'user.name', 'Policy Test');
  git(source, 'config', 'user.email', 'policy@example.test');
  writeFileSync(join(source, 'evidence.txt'), 'first\n');
  git(source, 'add', 'evidence.txt');
  git(source, 'commit', '-m', 'first');
  const ancestor = git(source, 'rev-parse', 'HEAD');
  writeFileSync(join(source, 'evidence.txt'), 'second\n');
  git(source, 'commit', '-am', 'second');
  git(source, 'remote', 'add', 'origin', remote);
  git(source, 'push', 'origin', 'HEAD:refs/heads/main');
  git(directory, 'clone', '--depth=1', '--branch', 'main', `file://${remote}`, checkout);
  assert.equal(git(checkout, 'rev-parse', '--is-shallow-repository'), 'true');
  const target = git(checkout, 'rev-parse', 'HEAD');
  await assert.rejects(ensurePolicyHistory(checkout, {
    token: 'test-token',
    serverUrl: 'https://github.com',
    repository: 'example-org/example-app',
  }), /remote or GitHub credential is invalid/);
  assert.equal(git(checkout, 'rev-parse', '--is-shallow-repository'), 'true');

  await ensurePolicyHistory(checkout);

  assert.equal(git(checkout, 'rev-parse', '--is-shallow-repository'), 'false');
  assert.equal(git(checkout, 'rev-parse', 'HEAD'), target);
  assert.equal(git(checkout, 'merge-base', '--is-ancestor', ancestor, target), '');
  assert.deepEqual(git(checkout, 'branch', '-r').split('\n'), ['origin/main']);
  await ensurePolicyHistory(checkout);
});
