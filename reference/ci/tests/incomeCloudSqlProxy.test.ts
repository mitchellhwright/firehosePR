import assert from 'node:assert/strict';
import test from 'node:test';

import {
  classifyProxyReadiness,
  cloudSqlProxyArguments,
  cloudSqlProxyExecutable,
  cloudSqlProxyExitLine,
  developmentInstanceConnectionName,
  proxyEnvironmentExports,
  proxyNotReadyMessage,
  proxyPidFile,
  proxyReadinessPattern,
} from '../src/ios/incomeCloudSqlProxy.ts';

test('the proxy binds loopback only and reaches the development instance', () => {
  assert.equal(cloudSqlProxyExecutable, 'cloud-sql-proxy');
  assert.deepEqual(cloudSqlProxyArguments(5599), [
    '--auto-iam-authn', '--address', '127.0.0.1', '--port', '5599',
    'example-app:us-central1:example-dev-postgres',
  ]);
  // The lane must never be able to reach production from a pull request.
  assert.equal(developmentInstanceConnectionName, 'example-app:us-central1:example-dev-postgres');
  assert.ok(!cloudSqlProxyArguments(1).includes('0.0.0.0'));
});

test('the readiness wait terminates on either the ready line or the exit line', () => {
  assert.equal(proxyReadinessPattern, 'ready for new connections|cloud-sql-proxy exited');
  assert.equal(
    classifyProxyReadiness('2026/09/21 12:00:00 The proxy has started successfully and is ready for new connections!'),
    'ready',
  );
  assert.equal(classifyProxyReadiness(cloudSqlProxyExitLine(1)), 'exited');
  assert.equal(classifyProxyReadiness(cloudSqlProxyExitLine(0)), 'exited');
  // Nothing matched at all is not a pass either.
  assert.equal(classifyProxyReadiness(''), 'exited');
});

test('the exit line the supervisor writes is the one both waits look for', () => {
  assert.equal(cloudSqlProxyExitLine(0), 'cloud-sql-proxy exited with 0');
  assert.equal(cloudSqlProxyExitLine(143), 'cloud-sql-proxy exited with 143');
  assert.ok(cloudSqlProxyExitLine(7).includes('cloud-sql-proxy exited'));
});

test('a failed start names the line it read', () => {
  assert.equal(
    proxyNotReadyMessage('cloud-sql-proxy exited with 1'),
    'Cloud SQL proxy did not become ready: cloud-sql-proxy exited with 1',
  );
  assert.equal(proxyNotReadyMessage(''), 'Cloud SQL proxy did not become ready: ');
});

test('the exported PID stays a string so an unstarted proxy exports nothing', () => {
  assert.deepEqual(proxyEnvironmentExports(5599, '4242'), {
    INCOME_E2E_DB_PROXY_PORT: '5599',
    INCOME_E2E_DB_PROXY_PID: '4242',
  });
  // The stop step's `if: env.INCOME_E2E_DB_PROXY_PID != ''` is what skips it.
  assert.equal(proxyEnvironmentExports(1, '').INCOME_E2E_DB_PROXY_PID, '');
  assert.equal(proxyPidFile('/run/income-e2e'), '/run/income-e2e/cloud-sql-proxy.pid');
});
