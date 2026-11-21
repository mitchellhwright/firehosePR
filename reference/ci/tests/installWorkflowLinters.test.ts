import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync,
  readFileSync, readdirSync, rmSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { installWorkflowLinters, pinnedWorkflowLinters, type PinnedLinter } from '../src/actions/installWorkflowLinters.ts';

test('both Linux architectures pin the queue-aware actionlint release', () => {
  assert.deepEqual(['x64', 'arm64'].map(architecture => {
    const actionlint = pinnedWorkflowLinters[architecture as 'x64' | 'arm64'][0];
    return { architecture, version: actionlint.version, url: actionlint.url, sha256: actionlint.sha256 };
  }), [
    { architecture: 'x64', version: '1.16.1',
      url: 'https://github.com/kjanat/actionlint/releases/download/v1.16.1/actionlint_1.16.1_linux_amd64.tar.gz',
      sha256: 'd566eee8af147ee1fa24ee204e1a171fcf8b5ce40e267c39a7383c7f20e6236d' },
    { architecture: 'arm64', version: '1.16.1',
      url: 'https://github.com/kjanat/actionlint/releases/download/v1.16.1/actionlint_1.16.1_linux_arm64.tar.gz',
      sha256: '8727b6749053bd7a910ce816117328dd9a3b9ed8a212129ee2ea6b0acb2cd812' },
  ]);
});

const archiveBytes = Buffer.from('fixture-pinned-linter-archive');
const spec: PinnedLinter = {
  name: 'actionlint', version: 'fixture',
  sha256: createHash('sha256').update(archiveBytes).digest('hex'),
  url: 'https://example.test/actionlint.tar.gz', archive: 'gz',
  member: 'actionlint', stripComponents: 0, versionArgument: '-version',
};

test('a verified binary is published once and subsequent jobs reuse the warm cache', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'workflow-linters-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const calls: string[] = [];
  const run = (command: string, arguments_: readonly string[]): number => {
    calls.push(command);
    if (command === 'curl') {
      const output = arguments_[arguments_.indexOf('--output') + 1];
      assert.ok(output);
      writeFileSync(output, archiveBytes);
    } else if (command === 'tar') {
      const outputDirectory = arguments_[arguments_.indexOf('-C') + 1];
      assert.ok(outputDirectory);
      writeFileSync(join(outputDirectory, spec.name), 'verified binary');
    } else {
      assert.equal(arguments_[0], '-version');
      assert.equal(readFileSync(command, 'utf8'), 'verified binary');
    }
    return 0;
  };
  const options = { platform: 'linux' as const, architecture: 'x64',
    environment: { RUNNER_TOOL_CACHE: root }, tools: [spec], run };
  const directory = installWorkflowLinters(options);
  assert.equal(readFileSync(join(directory, 'actionlint'), 'utf8'), 'verified binary');
  assert.equal(calls.filter(command => command === 'curl').length, 1);
  assert.equal(installWorkflowLinters(options), directory);
  assert.equal(calls.filter(command => command === 'curl').length, 1);
  assert.equal(readdirSync(directory).filter(name => name.startsWith('.staging-')).length, 0);
});

test('a checksum mismatch never publishes an unverified executable', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'workflow-linters-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const run = (command: string, arguments_: readonly string[]): number => {
    if (command === 'curl') {
      const output = arguments_[arguments_.indexOf('--output') + 1];
      assert.ok(output);
      writeFileSync(output, 'different bytes');
    } else assert.fail(`Unexpected command after a bad download: ${command}`);
    return 0;
  };
  assert.throws(() => installWorkflowLinters({ platform: 'linux', architecture: 'x64',
    environment: { RUNNER_TOOL_CACHE: root }, tools: [spec], run }), /Checksum mismatch/);
  const directory = join(root, 'example-workflow-linters', 'actionlint-1.16.1-shellcheck-v0.11.0');
  assert.equal(existsSync(join(directory, 'actionlint')), false);
  assert.equal(readdirSync(directory).length, 0);
});

test('a real gzip archive is extracted and its executable published atomically', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'workflow-linters-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const source = join(root, 'source');
  mkdirSync(source);
  const binary = join(source, 'actionlint');
  writeFileSync(binary, '#!/usr/bin/env node\nprocess.stdout.write("actionlint fixture\\n");\n');
  chmodSync(binary, 0o755);
  const archive = join(root, 'fixture.tar.gz');
  const created = spawnSync('tar', ['-czf', archive, '-C', source, 'actionlint']);
  assert.equal(created.status, 0, created.stderr?.toString());
  const realArchiveSpec = {
    ...spec, sha256: createHash('sha256').update(readFileSync(archive)).digest('hex'),
  };
  const run = (command: string, arguments_: readonly string[], quiet: boolean): number => {
    if (command === 'curl') {
      const output = arguments_[arguments_.indexOf('--output') + 1];
      assert.ok(output);
      copyFileSync(archive, output);
      return 0;
    }
    const result = spawnSync(command, [...arguments_], { stdio: quiet ? 'ignore' : 'pipe' });
    return result.status ?? 1;
  };
  const directory = installWorkflowLinters({ platform: 'linux', architecture: 'x64',
    environment: { RUNNER_TOOL_CACHE: root }, tools: [realArchiveSpec], run });
  const installed = spawnSync(join(directory, 'actionlint'), ['-version'], { encoding: 'utf8' });
  assert.equal(installed.status, 0, installed.stderr);
  assert.equal(installed.stdout, 'actionlint fixture\n');
  assert.equal(readdirSync(directory).filter(name => name.startsWith('.staging-')).length, 0);
});

test('unsupported hosts cannot install or reuse Linux-only tools', () => {
  assert.throws(() => installWorkflowLinters({ platform: 'darwin', architecture: 'arm64' }), /Linux runner/);
  assert.throws(() => installWorkflowLinters({ platform: 'linux', architecture: 'riscv64' }), /Unsupported/);
});
