import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  localSelectorMergeBase, prewarmNativeSelectorBlobs, resolveSelectorMergeBase,
} from '../src/actions/ios/prewarmNativeSelectorBlobs.ts';

const project = 'ios/example-ios.xcodeproj/project.pbxproj';
const plans = 'ios/example-ios.xcodeproj/xcshareddata/TestPlans';
const prepareAction = fileURLToPath(
  new URL('../src/actions/ios/prepareNativeSelectorHistory.ts', import.meta.url),
);

interface Fixture {
  readonly root: string;
  readonly origin: string;
  readonly checkout: string;
  readonly base: string;
  readonly head: string;
}

function git(cwd: string, args: readonly string[], env: NodeJS.ProcessEnv = process.env): string {
  return execFileSync('git', [...args], {
    cwd, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

/** What the selector sees: its lazy fetches cannot authenticate, so none may happen. */
function selectorGit(checkout: string, args: readonly string[]): string {
  return git(checkout, args, { ...process.env, GIT_NO_LAZY_FETCH: '1' });
}

function write(repo: string, path: string, content: string): void {
  mkdirSync(dirname(join(repo, path)), { recursive: true });
  writeFileSync(join(repo, path), content);
}

/**
 * A develop base, then a merge-queue style head on top of it, cloned the way
 * the Mac lanes check out: blob:none, bounded depth, exact head.
 */
function fixture(name: string, change: (source: string) => void): Fixture {
  const root = mkdtempSync(join(tmpdir(), `example-selector-blobs-${name}-`));
  const origin = join(root, 'origin.git');
  const source = join(root, 'source');
  const checkout = join(root, 'checkout');
  execFileSync('git', ['init', '--bare', origin]);
  git(origin, ['config', 'uploadpack.allowFilter', 'true']);
  git(origin, ['config', 'uploadpack.allowAnySHA1InWant', 'true']);
  execFileSync('git', ['init', '-b', 'develop', source]);
  git(source, ['config', 'user.name', 'CI Test']);
  git(source, ['config', 'user.email', 'ci@example.invalid']);
  write(source, project, 'project base\n');
  write(source, `${plans}/CI.xctestplan`, '{"plan":"base"}\n');
  write(source, `${plans}/Evidence.xctestplan`, '{"plan":"evidence"}\n');
  write(source, 'ios/example-iosTests/KeptTests.swift', 'final class KeptTests {}\n');
  write(source, 'ios/example-iosTests/RemovedTests.swift', 'final class RemovedTests {}\n');
  write(source, 'ios/example-ios/Assets/colors.json', '{"base":true}\n');
  git(source, ['add', '.']);
  git(source, ['commit', '-m', 'base']);
  const base = git(source, ['rev-parse', 'HEAD']);
  change(source);
  git(source, ['add', '-A']);
  git(source, ['commit', '-m', 'head']);
  const head = git(source, ['rev-parse', 'HEAD']);
  git(source, ['remote', 'add', 'origin', origin]);
  git(source, ['push', 'origin', 'develop']);
  execFileSync('git', ['clone', '--filter=blob:none', '--depth=2', '--branch', 'develop',
    `file://${origin}`, checkout], { stdio: 'ignore' });
  return { root, origin, checkout, base, head };
}

test('prewarm makes the merge-queue project patch readable without a lazy fetch', () => {
  const repo = fixture('project', (source) => {
    write(source, project, 'project head\n');
    write(source, `${plans}/CI.xctestplan`, '{"plan":"head"}\n');
    write(source, 'ios/example-iosTests/KeptTests.swift', 'final class KeptTests { func testNew() {} }\n');
    write(source, 'ios/example-ios/Assets/colors.json', '{"base":false}\n');
  });
  try {
    const { checkout, base, head } = repo;
    // The exact command that failed on the hosted Mac (job 108705231966).
    const projectPatch = ['diff', '--unified=0', `${base}...${head}`, '--', project];
    assert.throws(() => selectorGit(checkout, projectPatch), /lazy fetching disabled|could not fetch/u);

    prewarmNativeSelectorBlobs({ mergeBaseSha: base, headSha: head, cwd: checkout });

    assert.match(selectorGit(checkout, projectPatch), /\+project head/u);
    assert.equal(selectorGit(checkout, ['show', `${base}:${plans}/CI.xctestplan`]), '{"plan":"base"}');
    assert.match(selectorGit(checkout, [
      'diff', '--unified=0', '--no-ext-diff', `${base}...${head}`, '--', 'ios/example-iosTests/KeptTests.swift',
    ]), /testNew/u);
    // Only what the selector reads: a changed non-source iOS file stays remote.
    assert.throws(() => selectorGit(checkout, ['show', `${base}:ios/example-ios/Assets/colors.json`]));
  } finally {
    rmSync(repo.root, { recursive: true, force: true });
  }
});

test('a deleted test file is readable with the merge-base project and plans it is judged against', () => {
  const repo = fixture('deleted', (source) => {
    unlinkSync(join(source, 'ios/example-iosTests/RemovedTests.swift'));
  });
  try {
    const { checkout, base, head } = repo;
    const deletedSource = ['show', `${base}:ios/example-iosTests/RemovedTests.swift`];
    assert.throws(() => selectorGit(checkout, deletedSource));

    prewarmNativeSelectorBlobs({ mergeBaseSha: base, headSha: head, cwd: checkout });

    assert.equal(selectorGit(checkout, deletedSource), 'final class RemovedTests {}');
    // Unchanged merge-base files share the head blobs the checkout materialized.
    assert.equal(selectorGit(checkout, ['show', `${base}:${project}`]), 'project base');
    for (const plan of ['CI', 'Evidence']) {
      assert.match(selectorGit(checkout, ['show', `${base}:${plans}/${plan}.xctestplan`]), /"plan"/u);
    }
  } finally {
    rmSync(repo.root, { recursive: true, force: true });
  }
});

test('the checkout merge base is the one the selector computes, or null without shared history', () => {
  const repo = fixture('merge-base', (source) => write(source, project, 'project head\n'));
  try {
    const { checkout, base, head } = repo;
    assert.equal(localSelectorMergeBase({ baseSha: base, headSha: head, cwd: checkout }), base);
    const unrelated = 'f'.repeat(40);
    assert.equal(localSelectorMergeBase({ baseSha: unrelated, headSha: head, cwd: checkout }), null);
    assert.throws(() => localSelectorMergeBase({ baseSha: 'develop', headSha: head, cwd: checkout }));
  } finally {
    rmSync(repo.root, { recursive: true, force: true });
  }
});

test('a fresh shallow checkout without the advanced base fetches its ancestry, then prewarms', () => {
  const root = mkdtempSync(join(tmpdir(), 'example-selector-blobs-advanced-base-'));
  const origin = join(root, 'origin.git');
  const source = join(root, 'source');
  const checkout = join(root, 'checkout');
  try {
    execFileSync('git', ['init', '--bare', origin]);
    git(origin, ['config', 'uploadpack.allowFilter', 'true']);
    execFileSync('git', ['init', '-b', 'develop', source]);
    git(source, ['config', 'user.name', 'CI Test']);
    git(source, ['config', 'user.email', 'ci@example.invalid']);
    write(source, project, 'project ancestor\n');
    git(source, ['add', '.']);
    git(source, ['commit', '-m', 'ancestor']);
    const ancestor = git(source, ['rev-parse', 'HEAD']);
    git(source, ['checkout', '-b', 'feature']);
    write(source, project, 'project feature\n');
    git(source, ['commit', '-am', 'feature project edit']);
    const head = git(source, ['rev-parse', 'HEAD']);
    git(source, ['checkout', 'develop']);
    for (let index = 0; index < 3; index += 1) {
      write(source, 'server.txt', `develop ${index}\n`);
      git(source, ['add', '.']);
      git(source, ['commit', '-m', `develop ${index}`]);
    }
    const base = git(source, ['rev-parse', 'HEAD']);
    git(source, ['remote', 'add', 'origin', origin]);
    git(source, ['push', 'origin', 'develop', 'feature']);
    execFileSync('git', ['clone', '--filter=blob:none', '--depth=1', '--branch', 'feature',
      `file://${origin}`, checkout], { stdio: 'ignore' });
    const resolve = (baseSha: string) => resolveSelectorMergeBase({
      history: 'checkout', baseSha, headSha: head, remote: `file://${origin}`, cwd: checkout,
    });
    assert.equal(localSelectorMergeBase({ baseSha: base, headSha: head, cwd: checkout }), null);

    const mergeBase = resolve(base);
    assert.equal(mergeBase, ancestor);
    prewarmNativeSelectorBlobs({ mergeBaseSha: ancestor, headSha: head, cwd: checkout });
    assert.match(selectorGit(checkout, ['diff', '--unified=0', `${base}...${head}`, '--', project]),
      /\+project feature/u);
    // A base the remote cannot serve fails the step instead of skipping the prewarm.
    assert.throws(() => resolve('e'.repeat(40)));
    assert.equal(resolve(''), null);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('the prepare step prewarms a queue candidate from its checkout history with the Git credential', () => {
  const repo = fixture('action', (source) => write(source, project, 'project head\n'));
  const run = (history: string, base: string) => spawnSync(process.execPath, [prepareAction], {
    cwd: repo.checkout,
    encoding: 'utf8',
    env: {
      ...process.env,
      GITHUB_REPOSITORY: 'example-org/example-app',
      GITHUB_TOKEN: 'test-token',
      GITHUB_WORKSPACE: repo.checkout,
      IOS_AFFECTED_TESTS_BASE: base,
      IOS_AFFECTED_TESTS_HEAD: repo.head,
      IOS_SELECTOR_HISTORY: history,
    },
  });
  try {
    const { checkout, base, head } = repo;
    const noBase = run('checkout', '');
    assert.equal(noBase.status, 0, noBase.stderr);
    assert.match(noBase.stdout, /no base revision/u);

    const prepared = run('checkout', base);
    assert.equal(prepared.status, 0, prepared.stderr);
    assert.match(prepared.stdout, new RegExp(`merge base ${base}`, 'u'));
    assert.match(selectorGit(checkout, ['diff', '--unified=0', `${base}...${head}`, '--', project]),
      /\+project head/u);

    const missingPromotionBase = run('promotion', '');
    assert.notEqual(missingPromotionBase.status, 0);
    assert.match(missingPromotionBase.stderr, /IOS_AFFECTED_TESTS_BASE/u);
  } finally {
    rmSync(repo.root, { recursive: true, force: true });
  }
});
