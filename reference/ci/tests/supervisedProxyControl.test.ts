import assert from 'node:assert/strict';
import test from 'node:test';

import {
  isSupervisedProxyName,
  planProxyStop,
  supervisedProxies,
} from '../src/ios/supervisedProxyControl.ts';

const dashboard = supervisedProxies['dashboard-offline'];
const cloudSql = supervisedProxies['income-cloud-sql'];

const dashboardCommand = '/usr/bin/node ci/src/actions/ios/onboardingDashboardOfflineProxy.ts --port 51234';
const cloudSqlCommand =
  'cloud-sql-proxy --auto-iam-authn --address 127.0.0.1 --port 5599 example-app:us-central1:example-dev-postgres';

test('a matching command line is terminated and waited for', () => {
  assert.deepEqual(planProxyStop({ spec: dashboard, pid: '321', commandLine: dashboardCommand }), {
    kind: 'terminate',
    pid: 321,
    exitPattern: '"exited":',
    messages: [{ level: 'info', text: 'Dashboard offline proxy stopped' }],
    exitCode: 0,
  });
  assert.deepEqual(planProxyStop({ spec: cloudSql, pid: '99', commandLine: cloudSqlCommand }), {
    kind: 'terminate',
    pid: 99,
    exitPattern: 'cloud-sql-proxy exited',
    messages: [],
    exitCode: 0,
  });
});

test('ps output is trimmed before it is matched or reported', () => {
  const plan = planProxyStop({ spec: dashboard, pid: '7', commandLine: `  ${dashboardCommand}\n` });
  assert.equal(plan.kind, 'terminate');
});

test('an unrelated process is never signalled, whichever proxy asked', () => {
  // PIDs are recycled on a shared runner, so a matching PID with the wrong
  // command line means another job now owns it.
  for (const commandLine of ['/usr/sbin/sshd -D', 'node scripts/other-proxy.mjs', 'cloud-sql-proxy']) {
    const plan = planProxyStop({ spec: dashboard, pid: '5', commandLine });
    assert.equal(plan.kind, 'refuse', commandLine);
    assert.deepEqual(plan.messages, [
      { level: 'error', text: `Refusing to stop an unrelated process: ${commandLine}` },
    ]);
  }
});

test('the Cloud SQL proxy needs both markers, not just the executable name', () => {
  const wrongInstance = 'cloud-sql-proxy --port 1 example-app:us-central1:example-production-postgres';
  const plan = planProxyStop({ spec: cloudSql, pid: '5', commandLine: wrongInstance });
  assert.equal(plan.kind, 'refuse');
  assert.deepEqual(plan.messages, [
    { level: 'error', text: 'Refusing to stop an unowned process: 5' },
  ]);
});

test('an already-gone process is fine for the dashboard proxy and fatal for the Cloud SQL one', () => {
  // The dashboard proxy exits with the lane; the Cloud SQL proxy must still be
  // running, so a vanished PID means the database went away mid-run.
  assert.deepEqual(planProxyStop({ spec: dashboard, pid: '5', commandLine: '' }), {
    kind: 'skip',
    messages: [{ level: 'info', text: 'Dashboard offline proxy already stopped' }],
    exitCode: 0,
  });
  assert.equal(planProxyStop({ spec: cloudSql, pid: '5', commandLine: '' }).kind, 'refuse');
  assert.equal(planProxyStop({ spec: cloudSql, pid: '5', commandLine: '   \n' }).kind, 'refuse');
});

test('a PID that is not a run of digits is refused rather than signalled', () => {
  // `kill -TERM -1` would have signalled every process the runner owns, and a
  // trailing-garbage PID must not be silently truncated to a real one.
  for (const pid of ['-1', '0', '', 'abc', '12abc', '1.5', '1 2', '0x10']) {
    assert.equal(
      planProxyStop({ spec: dashboard, pid, commandLine: dashboardCommand }).kind,
      'refuse',
      pid,
    );
  }
  assert.equal(planProxyStop({ spec: dashboard, pid: ' 12 ', commandLine: dashboardCommand }).kind, 'terminate');
});

test('only the two declared proxies are accepted', () => {
  assert.deepEqual(Object.keys(supervisedProxies).sort(), ['dashboard-offline', 'income-cloud-sql']);
  assert.ok(isSupervisedProxyName('dashboard-offline'));
  for (const name of ['', 'dashboard', 'constructor', '__proto__']) {
    assert.equal(isSupervisedProxyName(name), false, name);
  }
});
