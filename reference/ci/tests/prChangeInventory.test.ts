import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { collectPrChangeInventory, parseGitChangeInventory, readPrInventoryFromGithub, readPrInventoryFromGit, selectPrInventorySource } from '../src/prChangeInventory.ts';
import type { GithubReader } from '../src/ios/shared/githubRest.ts';
import type { runCommand } from '../src/ios/shared/processRunner.ts';

const revision = { repository: 'owner/repo', prNumber: '42', headSha: 'a'.repeat(40), baseSha: 'b'.repeat(40), token: 'event-token', fallbackToken: 'fallback-token' };
const metadata = () => ({ base: { sha: revision.baseSha }, head: { sha: revision.headSha } });
const filesReader = (read: GithubReader): GithubReader => async url => url.includes('/files?') ? read(url) : response(metadata());
const response = (body: unknown, status = 200) => ({ status, statusLabel: String(status), body });

test('classifier selection requires a populated valid delta or proved equivalence', () => {
  const input = { superseded: false, valid: true, files: '', patchEquivalent: false };
  assert.equal(selectPrInventorySource(input), undefined);
  assert.deepEqual(selectPrInventorySource({ ...input, patchEquivalent: true }), { source: 'classifier', changed: [], deleted: [], metadataOnly: true });
  assert.deepEqual(selectPrInventorySource({ ...input, files: 'server/change.ts' }), { source: 'classifier', changed: ['server/change.ts'], deleted: [], metadataOnly: false });
  assert.equal(selectPrInventorySource({ ...input, valid: false, files: 'server/change.ts', patchEquivalent: true }), undefined);
  assert.deepEqual(selectPrInventorySource({ ...input, superseded: true, files: 'ignored' }), { source: 'superseded', changed: [], deleted: [], metadataOnly: true });
});

test('NUL inventory preserves removals, renames, copies, spaces and Unicode', () => {
  assert.deepEqual(parseGitChangeInventory(['D', 'removed.ts', 'R100', 'old.integration.ts', 'new.integration.ts', 'C75', 'source.ts', 'two words.ts', 'M', 'café.ts', ''].join('\0')), {
    changed: ['removed.ts', 'new.integration.ts', 'two words.ts', 'café.ts'], deleted: ['removed.ts', 'old.integration.ts'],
  });
  assert.deepEqual(parseGitChangeInventory(''), { changed: [], deleted: [] });
});
for (const input of ['M\0file', 'R100\0old\0', 'C100\0', 'wat\0file\0', 'M\0two\nfiles\0']) {
  test(`malformed Git inventory fails closed: ${JSON.stringify(input)}`, () => assert.throws(() => parseGitChangeInventory(input)));
}

test('GitHub pagination retains deleted and rename-origin paths', async () => {
  const urls: string[] = [];
  const first = Array.from({ length: 100 }, (_, i) => ({ filename: `file-${i}.ts`, status: 'modified' }));
  const read: GithubReader = async url => {
    urls.push(url);
    return response(urls.length === 1 ? first : [
      { filename: 'deleted.ts', status: 'removed' },
      { filename: 'new.ts', previous_filename: 'old.ts', status: 'renamed' },
    ]);
  };
  const inventory = await readPrInventoryFromGithub(revision, filesReader(read));
  assert.equal(inventory?.changed.length, 102);
  assert.deepEqual(inventory?.deleted, ['deleted.ts', 'old.ts']);
  assert.ok(urls[1]?.endsWith('per_page=100&page=2'));
});

test('only quota responses select Git fallback; malformed/error responses fail', async () => {
  for (const status of [403, 429]) assert.equal(await readPrInventoryFromGithub(revision, async () => response(undefined, status)), undefined);
  for (const status of [401, 404, 500]) await assert.rejects(readPrInventoryFromGithub(revision, async () => response(undefined, status)), new RegExp(`HTTP ${status}`));
  await assert.rejects(readPrInventoryFromGithub(revision, filesReader(async () => response([{ filename: 'new.ts', status: 'renamed' }]))));
  await assert.rejects(readPrInventoryFromGithub(revision, filesReader(async () => response({ message: 'not an inventory' }))));
});

test('capped GitHub file inventories cannot silently omit selected tests', async () => {
  let pages = 0;
  assert.equal(await readPrInventoryFromGithub(revision, filesReader(async () => {
    pages += 1;
    return response(Array.from({ length: 100 }, (_, i) => ({ filename: `page-${pages}-${i}`, status: 'modified' })));
  })), undefined);
  assert.equal(pages, 30);
});

function gitFixture(options: { shallow?: boolean; changedHead?: boolean; failFetch?: boolean } = {}) {
  const calls: (readonly string[])[] = [];
  const run: typeof runCommand = async (program, args, runOptions) => {
    assert.equal(program, 'git');
    assert.equal(runOptions?.capture, true);
    assert.ok(!args.join(' ').includes(revision.token));
    assert.equal(runOptions?.env?.GIT_TERMINAL_PROMPT, '0');
    assert.equal(runOptions?.env?.GIT_CONFIG_VALUE_0, '');
    calls.push(args);
    let stdout = '';
    if (args[0] === 'fetch' && options.failFetch) return { status: 23, stdout, stderr: 'fetch failed' };
    if (args[0] === 'rev-parse') stdout = args[1] === '--is-shallow-repository' ? String(options.shallow ?? false)
      : args[1]?.includes('inventory-base-') ? revision.baseSha : options.changedHead ? 'c'.repeat(40) : revision.headSha;
    if (args[0] === 'merge-base') stdout = 'd'.repeat(40);
    if (args[0] === 'diff') stdout = 'R100\0old.ts\0new.ts\0';
    return { status: 0, stdout, stderr: '' };
  };
  return { calls, run };
}
for (const shallow of [true, false]) {
  test(`Git fallback verifies the exact refs and cleans them (shallow=${shallow})`, async () => {
    const { calls, run } = gitFixture({ shallow });
    assert.deepEqual(await readPrInventoryFromGit(revision, run), { changed: ['new.ts'], deleted: ['old.ts'] });
    assert.equal(calls.find(args => args[0] === 'fetch')?.includes('--unshallow'), shallow);
    assert.equal(calls.filter(args => args[0] === 'update-ref').length, 2);
    assert.deepEqual(calls.find(args => args[0] === 'diff')?.slice(0, 5), ['diff', '--name-status', '-z', '--find-renames', 'd'.repeat(40)]);
  });
}
for (const options of [{ changedHead: true }, { failFetch: true }]) {
  test(`Git fallback cleans both refs on ${JSON.stringify(options)}`, async () => {
    const { calls, run } = gitFixture(options);
    await assert.rejects(readPrInventoryFromGit(revision, run));
    assert.equal(calls.filter(args => args[0] === 'update-ref').length, 2);
    assert.equal(calls.some(args => args[0] === 'diff'), false);
  });
}

test('quota on a later API page discards the partial inventory before exact Git fallback', async () => {
  let pages = 0;
  const { run } = gitFixture();
  const inventory = await collectPrChangeInventory(revision, filesReader(async () => {
    pages += 1;
    return pages === 1 ? response(Array.from({ length: 100 }, (_, i) => ({ filename: `partial-${i}`, status: 'removed' }))) : response(undefined, 429);
  }), run);
  assert.deepEqual(inventory, { changed: ['new.ts'], deleted: ['old.ts'] });
});

test('collector adapter clears stale files and preserves classifier metadata outputs without credentials', t => {
  const root = mkdtempSync(join(tmpdir(), 'pr-inventory-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const deleted = join(root, 'deleted');
  const outputs = join(root, 'outputs');
  writeFileSync(deleted, 'stale.ts');
  writeFileSync(join(root, 'pr-changed-files.txt'), 'stale.ts');
  const result = spawnSync(process.execPath, ['ci/src/actions/collectPrChangeInventory.ts'], { encoding: 'utf8', env: {
    ...process.env, RUNNER_TEMP: root, DELETED_FILES_INVENTORY_FILE: deleted, GITHUB_OUTPUT: outputs,
    EVENT_NAME: 'pull_request', CONTROLLER_BASE_UPDATE_VALID: 'true',
    CONTROLLER_BASE_UPDATE_FILES: '', CONTROLLER_BASE_UPDATE_PATCH_EQUIVALENT: 'true',
  } });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(readFileSync(deleted, 'utf8'), '');
  assert.equal(readFileSync(join(root, 'pr-changed-files.txt'), 'utf8'), '\n');
  assert.match(readFileSync(outputs, 'utf8'), /metadata_only=true\nclassifier_inventory_selected=true\nfile_status_inventory_verified=false/);
});

test('cancellation after fetch stops inventory commands and still removes both scoped refs', async () => {
  const cancellation = new AbortController();
  const fixture = gitFixture();
  const run: typeof runCommand = async (program, args, options) => {
    const result = await fixture.run(program, args, options);
    if (args[0] === 'fetch') cancellation.abort();
    return result;
  };
  await assert.rejects(readPrInventoryFromGit(revision, run, cancellation.signal));
  assert.equal(fixture.calls.filter(args => args[0] === 'update-ref').length, 2);
  assert.equal(fixture.calls.some(args => args[0] === 'merge-base' || args[0] === 'diff'), false);
});

for (const phase of ['before', 'after'] as const) {
  for (const field of ['head', 'base'] as const) {
    test(`API rejects a ${field} revision change ${phase} pagination`, async () => {
      let checks = 0;
      let pages = 0;
      const read: GithubReader = async url => {
        if (url.includes('/files?')) { pages += 1; return response([{ filename: 'stale.ts', status: 'modified' }]); }
        checks += 1;
        const current = metadata();
        if (phase === 'before' || checks === 2) current[field].sha = 'c'.repeat(40);
        return response(current);
      };
      await assert.rejects(readPrInventoryFromGithub(revision, read), /revision changed/);
      assert.equal(pages, phase === 'before' ? 0 : 1);
    });
  }
}

test('quota on final tuple verification discards API inventory before exact Git fallback', async () => {
  let checks = 0;
  const { run } = gitFixture();
  const read: GithubReader = async url => {
    if (url.includes('/files?')) return response([{ filename: 'partial.ts', status: 'removed' }]);
    checks += 1;
    return checks === 1 ? response(metadata()) : response(undefined, 429);
  };
  assert.deepEqual(await collectPrChangeInventory(revision, read, run), { changed: ['new.ts'], deleted: ['old.ts'] });
});
