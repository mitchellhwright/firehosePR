import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { selectXcode } from '../src/actions/ios/selectXcode.ts';
import { pinnedIosXcodeToolchain } from '../src/ios/toolchainPolicy.ts';

function fixture(t: import('node:test').TestContext) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'example-select-xcode-')));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const applications = join(root, 'Applications');
  const bin = join(root, 'bin');
  mkdirSync(applications);
  mkdirSync(bin);
  writeFileSync(join(bin, 'xcode-select'), '#!/bin/sh\nexit 2\n');
  chmodSync(join(bin, 'xcode-select'), 0o755);
  const githubEnv = join(root, 'github-env');
  const githubOutput = join(root, 'github-output');
  writeFileSync(githubEnv, '');
  writeFileSync(githubOutput, '');
  const env: NodeJS.ProcessEnv = {
    PATH: `${bin}:/usr/bin:/bin`,
    RUNNER_NAME: 'fixture-mac',
    GITHUB_ENV: githubEnv,
    GITHUB_OUTPUT: githubOutput,
  };
  const install = (appName: string, version: string, build: string): string => {
    const developer = join(applications, appName, 'Contents/Developer');
    mkdirSync(join(developer, 'usr/bin'), { recursive: true });
    const xcodebuild = join(developer, 'usr/bin/xcodebuild');
    writeFileSync(xcodebuild, `#!/bin/sh\nprintf 'Xcode ${version}\\nBuild version ${build}\\n'\n`);
    chmodSync(xcodebuild, 0o755);
    return developer;
  };
  return { applications, env, githubEnv, githubOutput, install };
}

function captureStderr(t: import('node:test').TestContext): string[] {
  const lines: string[] = [];
  t.mock.method(console, 'error', (...args: unknown[]) => { lines.push(args.join(' ')); });
  return lines;
}

test('selects the pinned Xcode when another Xcode is the default app', (t) => {
  const f = fixture(t);
  f.install('Xcode.app', '26.6', '17F113');
  const pinned = f.install('Xcode-27.0.app', '27.0', '27A266a');
  assert.equal(selectXcode(['27.0@27A266a'], f.env, f.applications), 0);
  assert.equal(readFileSync(f.githubEnv, 'utf8'), `DEVELOPER_DIR=${pinned}\n`);
  assert.equal(readFileSync(f.githubOutput, 'utf8'), 'xcode-version=27.0\nxcode-build=27A266a\n');
});

test('selects the pinned Xcode named by DEVELOPER_DIR outside the applications folder', (t) => {
  const f = fixture(t);
  const pinned = f.install('elsewhere/Xcode.app', '27.0', '27A266a');
  const env = { ...f.env, DEVELOPER_DIR: pinned };
  assert.equal(selectXcode(['27.0@27A266a'], env, join(f.applications, 'missing')), 0);
  assert.equal(readFileSync(f.githubEnv, 'utf8'), `DEVELOPER_DIR=${pinned}\n`);
});

test('fails with the runner, the pin and the installed versions when the pin is absent', (t) => {
  const f = fixture(t);
  f.install('Xcode.app', '26.6', '17F113');
  const stderr = captureStderr(t);
  assert.equal(selectXcode(['27.0@27A266a'], f.env, f.applications), 1);
  const report = stderr.join('\n');
  assert.match(report, /fixture-mac does not have the pinned Xcode 27\.0 \(27A266a\)/);
  assert.match(report, /never falls back/);
  assert.ok(report.includes(join(f.applications, 'Xcode-27.0.app')));
  assert.ok(report.includes(`26.6 (17F113)\t${join(f.applications, 'Xcode.app')}`));
  assert.equal(readFileSync(f.githubEnv, 'utf8'), '');
});

test('rejects the same version with a different build', (t) => {
  const f = fixture(t);
  f.install('Xcode.app', '27.0', '27A999z');
  const stderr = captureStderr(t);
  assert.equal(selectXcode(['27.0@27A266a'], f.env, f.applications), 1);
  assert.ok(stderr.join('\n').includes('27.0 (27A999z)'));
  assert.equal(readFileSync(f.githubEnv, 'utf8'), '');
});

test('reports when no Xcode is installed at all', (t) => {
  const f = fixture(t);
  const stderr = captureStderr(t);
  assert.equal(selectXcode(['27.0@27A266a'], f.env, f.applications), 1);
  assert.match(stderr.join('\n'), /No Xcode installation was found/);
});

test('accepts exactly one version@build pin', (t) => {
  const f = fixture(t);
  f.install('Xcode.app', '27.0', '27A266a');
  captureStderr(t);
  for (const args of [[], ['26'], ['27.0'], ['27.0@27A266a', '26.6@17F113']]) {
    assert.equal(selectXcode(args, f.env, f.applications), 2, args.join(' '));
  }
  assert.equal(readFileSync(f.githubEnv, 'utf8'), '');
});

test('the Python image profile describes the pinned Xcode and nothing else', () => {
  const source = readFileSync(new URL('../../scripts/ios-ci-image-prerequisites.py', import.meta.url), 'utf8');
  const versions = [...source.matchAll(/'xcode_version': '([^']+)'/g)].map((match) => match[1]);
  const builds = [...source.matchAll(/'xcode_build': '([^']+)'/g)].map((match) => match[1]);
  const [version, build] = pinnedIosXcodeToolchain.split('@');
  assert.deepEqual(versions, [version]);
  assert.deepEqual(builds, [build]);
});
