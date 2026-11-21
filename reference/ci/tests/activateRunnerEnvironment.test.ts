import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const script = fileURLToPath(
  new URL('../../scripts/activate-github-actions-runner-environment.sh', import.meta.url),
);
const context = 'runner-environment/ios-host-tg1/36246765796/1';
const launchdLabel = 'com.example.example-runner-environment-ios-host-tg1-36246765796-1';

interface Host {
  readonly root: string;
  readonly runnerRoot: string;
  readonly log: string;
  readonly launchctlCalls: string;
  readonly tokenFile: string;
  readonly marker: string;
}

function fakeBin(directory: string, name: string, body: string): string {
  const path = join(directory, name);
  writeFileSync(path, `#!/bin/bash\n${body}\n`);
  chmodSync(path, 0o755);
  return path;
}

function macHost(): Host {
  const root = mkdtempSync(join(tmpdir(), 'runner-activation-'));
  const runnerRoot = join(root, 'runners', 'tg1');
  mkdirSync(join(runnerRoot, 'bin'), { recursive: true });
  const tokenFile = join(root, 'activation.token');
  writeFileSync(tokenFile, 'scoped-token');
  return {
    root,
    runnerRoot,
    log: join(root, 'activation.log'),
    launchctlCalls: join(root, 'launchctl.calls'),
    tokenFile,
    marker: join(root, 'activation.completed'),
  };
}

function activate(host: Host): ReturnType<typeof spawnSync> {
  const bin = join(host.root, 'bin');
  mkdirSync(bin, { recursive: true });
  const environment = {
    PATH: process.env['PATH'] ?? '/usr/bin:/bin',
    HOME: host.root,
    EXAMPLE_RUNNER_PS_BIN: fakeBin(bin, 'ps', 'exit 0'),
    EXAMPLE_RUNNER_PGREP_BIN: fakeBin(bin, 'pgrep', 'exit 1'),
    EXAMPLE_RUNNER_SLEEP_BIN: fakeBin(bin, 'sleep', 'exit 0'),
    EXAMPLE_RUNNER_CURL_BIN: fakeBin(bin, 'curl', 'exit 0'),
    EXAMPLE_RUNNER_LAUNCHCTL_BIN: fakeBin(bin, 'launchctl', `printf '%s\\n' "$*" >> '${host.launchctlCalls}'`),
    EXAMPLE_ACTIVATION_LAUNCHD_LABEL: launchdLabel,
  };
  return spawnSync('bash', [
    script, host.runnerRoot, 'macos', host.log, '4242', host.tokenFile,
    'https://api.github.com', 'example-org/example-app', 'a'.repeat(40), context, '0',
    join(host.root, 'activation.accepted'), join(host.root, 'activation.revoked'), host.marker,
  ], { encoding: 'utf8', env: environment });
}

function launchctlCalls(host: Host): string[] {
  try {
    return readFileSync(host.launchctlCalls, 'utf8').trim().split('\n');
  } catch {
    return [];
  }
}

function markerState(host: Host): unknown {
  return (JSON.parse(readFileSync(host.marker, 'utf8')) as { state: unknown }).state;
}

test('a listener without a service identity fails with the svc.sh remedy', () => {
  const host = macHost();
  const result = activate(host);
  assert.equal(result.status, 1);
  assert.equal(markerState(host), 'failure');
  const log = readFileSync(host.log, 'utf8');
  assert.match(log, /Runner service identity is missing under .*runners\/tg1\./);
  assert.ok(log.includes(`cd ${host.runnerRoot} && ./svc.sh install && ./svc.sh start`), log);
  assert.deepEqual(launchctlCalls(host), [`remove ${launchdLabel}`]);
});

test('a serviced listener restarts and its launchd job removes itself last', () => {
  const host = macHost();
  const plist = join(host.root, 'actions.runner.example-org.tg-1.plist');
  writeFileSync(plist, '<plist/>');
  writeFileSync(join(host.runnerRoot, '.service'), `${plist}\n`);
  const result = activate(host);
  assert.equal(result.status, 0, readFileSync(host.log, 'utf8'));
  assert.equal(markerState(host), 'success');
  assert.deepEqual(launchctlCalls(host), [
    `unload ${plist}`, `load -w ${plist}`, `remove ${launchdLabel}`,
  ]);
});

test('a relaunch after the handoff was consumed still removes its launchd job', () => {
  const host = macHost();
  activate(host);
  writeFileSync(host.launchctlCalls, '');
  const relaunch = activate(host);
  assert.equal(relaunch.status, 1);
  assert.match(readFileSync(host.log, 'utf8'), /Completion token file does not exist/);
  assert.deepEqual(launchctlCalls(host), [`remove ${launchdLabel}`]);
});
