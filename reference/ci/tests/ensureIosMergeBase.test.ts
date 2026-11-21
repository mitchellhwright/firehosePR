import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import {
  chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import {
  ensureIosMergeBase, IosMergeBaseGitTimeout,
} from '../src/actions/ios/ensureIosMergeBase.ts';
import { prewarmNativeSelectorBlobs } from '../src/actions/ios/prewarmNativeSelectorBlobs.ts';

test('shallow PR checkout recovers exact base-update merge ancestry and project patch', () => {
  const root = mkdtempSync(join(tmpdir(), 'example-ios-merge-base-'));
  const origin = join(root, 'origin.git');
  const source = join(root, 'source');
  const checkout = join(root, 'checkout');
  const git = (cwd: string, args: readonly string[]): string => execFileSync('git', [...args], {
    cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
  try {
    execFileSync('git', ['init', '--bare', origin]);
    execFileSync('git', ['init', '-b', 'develop', source]);
    git(source, ['config', 'user.name', 'CI Test']);
    git(source, ['config', 'user.email', 'ci@example.invalid']);
    writeFileSync(join(source, 'project.pbxproj'), 'base\n');
    git(source, ['add', '.']);
    git(source, ['commit', '-m', 'base']);
    const ancestor = git(source, ['rev-parse', 'HEAD']);
    git(source, ['remote', 'add', 'origin', origin]);
    git(source, ['checkout', '-b', 'feature']);
    writeFileSync(join(source, 'project.pbxproj'), 'feature\n');
    git(source, ['commit', '-am', 'project edit']);
    git(source, ['checkout', 'develop']);
    writeFileSync(join(source, 'base.txt'), 'updated\n');
    git(source, ['add', '.']);
    git(source, ['commit', '-m', 'base update']);
    const base = git(source, ['rev-parse', 'HEAD']);
    git(source, ['checkout', 'feature']);
    git(source, ['merge', '--no-ff', 'develop', '-m', 'merge base update']);
    const head = git(source, ['rev-parse', 'HEAD']);
    git(source, ['push', 'origin', 'develop', 'feature']);
    git(origin, ['update-ref', 'refs/pull/1/head', head]);
    execFileSync('git', ['clone', '--depth=1', '--branch', 'feature', `file://${origin}`, checkout]);
    assert.throws(() => git(checkout, ['merge-base', base, 'HEAD']));
    assert.equal(ensureIosMergeBase({ baseSha: base, headSha: head, prNumber: '1', remote: `file://${origin}`, cwd: checkout }), base);
    assert.match(git(checkout, ['diff', `${base}...${head}`, '--', 'project.pbxproj']), /\+feature/);
    // A full checkout has no promisor remote, so the fetched ancestry must carry its blobs.
    assert.equal(git(checkout, ['show', `${base}:base.txt`]), 'updated');
    git(origin, ['update-ref', 'refs/pull/1/head', ancestor]);
    assert.throws(() => ensureIosMergeBase({
      baseSha: base, headSha: head, prNumber: '1', remote: `file://${origin}`, cwd: checkout,
    }), /iOS base or head changed/);
    assert.notEqual(ancestor, base);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('diverged exact source/base history remains comparable after bounded fetch', () => {
  const root = mkdtempSync(join(tmpdir(), 'example-ios-deepen-'));
  const origin = join(root, 'origin.git');
  const source = join(root, 'source');
  const checkout = join(root, 'checkout');
  const git = (cwd: string, args: readonly string[]): string => execFileSync('git', [...args], {
    cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
  try {
    execFileSync('git', ['init', '--bare', origin]);
    git(origin, ['config', 'uploadpack.allowFilter', 'true']);
    execFileSync('git', ['init', '-b', 'develop', source]);
    git(source, ['config', 'user.name', 'CI Test']);
    git(source, ['config', 'user.email', 'ci@example.invalid']);
    mkdirSync(join(source, 'ios'));
    writeFileSync(join(source, 'ios/project.pbxproj'), 'base\n');
    git(source, ['add', '.']);
    git(source, ['commit', '-m', 'common ancestor']);
    const ancestor = git(source, ['rev-parse', 'HEAD']);
    git(source, ['remote', 'add', 'origin', origin]);
    git(source, ['checkout', '-b', 'feature']);
    for (let index = 0; index < 20; index += 1) {
      writeFileSync(join(source, 'ios/project.pbxproj'), `feature ${index}\n`);
      git(source, ['commit', '-am', `feature ${index}`]);
    }
    const head = git(source, ['rev-parse', 'HEAD']);
    git(source, ['checkout', 'develop']);
    for (let index = 0; index < 20; index += 1) {
      writeFileSync(join(source, 'base.txt'), `base ${index}\n`);
      git(source, ['add', '.']);
      git(source, ['commit', '-m', `develop ${index}`]);
    }
    const base = git(source, ['rev-parse', 'HEAD']);
    git(source, ['push', 'origin', 'develop', 'feature']);
    git(origin, ['update-ref', 'refs/pull/1/head', head]);
    execFileSync('git', ['clone', '--filter=blob:none', '--depth=1', '--branch', 'feature', `file://${origin}`, checkout]);
    assert.equal(ensureIosMergeBase({ baseSha: base, headSha: head, remote: `file://${origin}`, cwd: checkout }), ancestor);
    assert.equal(git(checkout, ['rev-parse', base]), base);
    assert.equal(git(checkout, ['rev-parse', head]), head);
    const noFetchGit = (args: readonly string[]): string => execFileSync('git', [...args], {
      cwd: checkout,
      env: { ...process.env, GIT_NO_LAZY_FETCH: '1' },
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trim();
    // The blob:none checkout stays blob:none: ancestry fetches carry commits and trees only.
    assert.throws(() => noFetchGit(['show', `${base}:base.txt`]));
    assert.throws(() => noFetchGit(['show', `${ancestor}:ios/project.pbxproj`]));
    prewarmNativeSelectorBlobs({ mergeBaseSha: ancestor, headSha: head, cwd: checkout });
    assert.equal(noFetchGit(['show', `${ancestor}:ios/project.pbxproj`]), 'base');
    assert.match(git(checkout, ['diff', `${base}...${head}`, '--', 'ios/project.pbxproj']), /\+feature 19/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('promotion patch prewarm materializes missing iOS blobs from a partial clone', () => {
  const root = mkdtempSync(join(tmpdir(), 'example-ios-blob-prewarm-'));
  const origin = join(root, 'origin.git');
  const source = join(root, 'source');
  const checkout = join(root, 'checkout');
  const git = (cwd: string, args: readonly string[], noLazyFetch = false): string =>
    execFileSync('git', [...args], {
      cwd,
      env: { ...process.env, ...(noLazyFetch ? { GIT_NO_LAZY_FETCH: '1' } : {}) },
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trim();
  try {
    execFileSync('git', ['init', '--bare', origin]);
    git(origin, ['config', 'uploadpack.allowFilter', 'true']);
    execFileSync('git', ['init', '-b', 'develop', source]);
    git(source, ['config', 'user.name', 'CI Test']);
    git(source, ['config', 'user.email', 'ci@example.invalid']);
    mkdirSync(join(source, 'ios'));
    writeFileSync(join(source, 'ios/Contract.swift'), 'struct Original {}\n');
    git(source, ['add', '.']);
    git(source, ['commit', '-m', 'base']);
    const base = git(source, ['rev-parse', 'HEAD']);
    writeFileSync(join(source, 'ios/Contract.swift'), 'struct Changed {}\n');
    git(source, ['commit', '-am', 'head']);
    const head = git(source, ['rev-parse', 'HEAD']);
    git(source, ['remote', 'add', 'origin', origin]);
    git(source, ['push', 'origin', 'develop']);
    execFileSync('git', ['clone', '--filter=blob:none', '--depth=1', '--branch', 'develop',
      `file://${origin}`, checkout]);
    git(checkout, ['fetch', '--filter=blob:none', '--unshallow', 'origin', 'develop']);
    assert.throws(() => git(checkout, ['show', `${base}:ios/Contract.swift`], true));
    prewarmNativeSelectorBlobs({ mergeBaseSha: base, headSha: head, cwd: checkout });
    assert.equal(git(checkout, ['show', `${base}:ios/Contract.swift`], true), 'struct Original {}');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('selector history fetches never start automatic Git maintenance in the checkout', () => {
  // A detached auto-gc from one fetch rewrote .git/shallow while the next
  // --deepen fetch read it ("shallow file has changed since we read it").
  const root = mkdtempSync(join(tmpdir(), 'example-ios-no-auto-gc-'));
  const origin = join(root, 'origin.git');
  const source = join(root, 'source');
  const checkout = join(root, 'checkout');
  const marker = join(root, 'auto-gc-ran');
  const git = (cwd: string, args: readonly string[]): string => execFileSync('git', [...args], {
    cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
  try {
    execFileSync('git', ['init', '--bare', origin]);
    git(origin, ['config', 'uploadpack.allowFilter', 'true']);
    execFileSync('git', ['init', '-b', 'develop', source]);
    git(source, ['config', 'user.name', 'CI Test']);
    git(source, ['config', 'user.email', 'ci@example.invalid']);
    mkdirSync(join(source, 'ios'));
    writeFileSync(join(source, 'ios/Contract.swift'), 'struct Base {}\n');
    git(source, ['add', '.']);
    git(source, ['commit', '-m', 'ancestor']);
    const ancestor = git(source, ['rev-parse', 'HEAD']);
    git(source, ['checkout', '-b', 'feature']);
    for (let index = 0; index < 20; index += 1) {
      writeFileSync(join(source, 'ios/Contract.swift'), `struct Feature${index} {}\n`);
      git(source, ['commit', '-am', `feature ${index}`]);
    }
    const head = git(source, ['rev-parse', 'HEAD']);
    git(source, ['checkout', 'develop']);
    for (let index = 0; index < 20; index += 1) {
      writeFileSync(join(source, 'base.txt'), `base ${index}\n`);
      git(source, ['add', '.']);
      git(source, ['commit', '-m', `develop ${index}`]);
    }
    const base = git(source, ['rev-parse', 'HEAD']);
    git(source, ['remote', 'add', 'origin', origin]);
    git(source, ['push', 'origin', 'develop', 'feature']);
    execFileSync('git', ['clone', '--filter=blob:none', '--depth=1', '--branch', 'feature',
      `file://${origin}`, checkout]);
    // Keep every fetched pack and let one extra pack trigger auto-gc, so any
    // fetch that is allowed to start maintenance does so synchronously here.
    git(checkout, ['config', 'fetch.unpackLimit', '1']);
    git(checkout, ['config', 'gc.auto', '1']);
    git(checkout, ['config', 'gc.autoPackLimit', '1']);
    git(checkout, ['config', 'gc.autoDetach', 'false']);
    const hook = join(checkout, '.git/hooks/pre-auto-gc');
    writeFileSync(hook, `#!/bin/sh\ntouch '${marker}'\nexit 1\n`);
    chmodSync(hook, 0o755);

    assert.equal(ensureIosMergeBase({
      baseSha: base, headSha: head, remote: `file://${origin}`, cwd: checkout,
    }), ancestor);
    prewarmNativeSelectorBlobs({ mergeBaseSha: ancestor, headSha: head, cwd: checkout });
    assert.equal(existsSync(marker), false, 'a selector Git command started automatic maintenance');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('a stalled ancestry fetch fails with a typed timeout naming the Git command', () => {
  const root = mkdtempSync(join(tmpdir(), 'example-ios-fetch-timeout-'));
  const checkout = join(root, 'checkout');
  const stalledRemote = join(root, 'stalled-remote.sh');
  const git = (args: readonly string[]): string => execFileSync('git', [...args], {
    cwd: checkout, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
  try {
    execFileSync('git', ['init', '-b', 'develop', checkout]);
    git(['config', 'user.name', 'CI Test']);
    git(['config', 'user.email', 'ci@example.invalid']);
    git(['commit', '--allow-empty', '-m', 'head']);
    const head = git(['rev-parse', 'HEAD']);
    // The remote never answers; its stderr is closed so only the killed fetch holds our pipes.
    writeFileSync(stalledRemote, '#!/bin/sh\nexec 2>/dev/null\nexec sleep 5\n');
    chmodSync(stalledRemote, 0o755);
    const started = Date.now();
    assert.throws(() => ensureIosMergeBase({
      baseSha: 'a'.repeat(40),
      headSha: head,
      remote: `ext::${stalledRemote}`,
      cwd: checkout,
      env: {
        ...process.env,
        GIT_CONFIG_COUNT: '1',
        GIT_CONFIG_KEY_0: 'protocol.ext.allow',
        GIT_CONFIG_VALUE_0: 'always',
      },
      gitTimeoutMs: 500,
    }), (error: unknown) => error instanceof IosMergeBaseGitTimeout
      && /`git fetch --no-tags --depth=16 ext:.*` did not finish within 0\.5s/.test(error.message));
    assert.ok(Date.now() - started < 4_000, 'the timeout must stop the stalled fetch');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('non-iOS PR classification completes without Git history or a fetch credential', () => {
  const root = mkdtempSync(join(tmpdir(), 'example-ios-no-fetch-'));
  const output = join(root, 'github-output');
  try {
    const result = spawnSync(process.execPath, ['ci/src/actions/ios/detectIosChanges.ts'], {
      cwd: process.cwd(),
      encoding: 'utf8',
      env: {
        ...process.env,
        EVENT_NAME: 'pull_request',
        CONTROLLER_BASE_UPDATE_VALID: 'true',
        CONTROLLER_BASE_UPDATE_FILES: 'README.md',
        FORCED_IOS_AUXILIARY: '[]',
        FORCED_IOS_LANES: '[]',
        IOS_AFFECTED_TESTS_BASE: 'invalid-base',
        IOS_AFFECTED_TESTS_HEAD: 'invalid-head',
        GITHUB_TOKEN: '',
        GITHUB_OUTPUT: output,
        RUNNER_TEMP: root,
      },
    });
    assert.equal(result.status, 0, result.stderr);
    assert.match(readFileSync(output, 'utf8'), /should_run=false/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
