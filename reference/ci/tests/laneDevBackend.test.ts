import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  backendCommand,
  backendEnvironment,
  backendExitStatus,
  backendExitedDevserverLine,
  backendExitedSupervisorLine,
  dependencyInstallRequired,
  dotenvSource,
  dotenvTestOtpSecret,
  forceStoppingListenersLine,
  givingUpDevserverLine,
  givingUpSupervisorLine,
  incomeProviderAuditLog,
  maxBackendRestarts,
  metadataProbeSatisfied,
  otpProbeConfirmed,
  devServerReadyPattern,
  isDevServerReadyLine,
  probeEmail,
  processGroupIsolated,
  readinessVerdict,
  resolveTestOtpSecret,
  splitCompleteLines,
  secretIsBlank,
  startingBackendDevserverLine,
  supervisorMarkers,
  supervisorRestartVerdict,
  supervisorTimestamp,
  tailLines,
} from '../src/ios/laneDevBackend.ts';

describe('dotenvTestOtpSecret', () => {
  it('takes the last assignment, so a later override wins as it did for grep | tail -1', () => {
    const secret = dotenvTestOtpSecret('TEST_OTP_SECRET=first\nOTHER=x\nTEST_OTP_SECRET=second\n');
    assert.equal(secret, 'second');
  });

  it('ignores a key that merely ends in the name', () => {
    assert.equal(dotenvTestOtpSecret('NOT_TEST_OTP_SECRET=nope\n'), '');
  });

  it('ignores the name inside a value', () => {
    assert.equal(dotenvTestOtpSecret('OTHER=TEST_OTP_SECRET=nope\n'), '');
  });

  it('accepts leading whitespace and whitespace before the equals sign', () => {
    assert.equal(dotenvTestOtpSecret('\t TEST_OTP_SECRET \t= value\n'), ' value');
  });

  it('keeps everything after the first equals sign, including further ones', () => {
    assert.equal(dotenvTestOtpSecret('TEST_OTP_SECRET=a=b=c\n'), 'a=b=c');
  });

  it('strips one layer of double quotes', () => {
    assert.equal(dotenvTestOtpSecret('TEST_OTP_SECRET="quoted"\n'), 'quoted');
  });

  it('strips one layer of single quotes', () => {
    assert.equal(dotenvTestOtpSecret("TEST_OTP_SECRET='quoted'\n"), 'quoted');
  });

  it('strips a quote present on one side only, as the shell expansions did', () => {
    assert.equal(dotenvTestOtpSecret('TEST_OTP_SECRET="half\n'), 'half');
    assert.equal(dotenvTestOtpSecret("TEST_OTP_SECRET=half'\n"), 'half');
  });

  it('leaves a lone quote character empty rather than dropping it twice', () => {
    assert.equal(dotenvTestOtpSecret('TEST_OTP_SECRET="\n'), '');
  });

  it('reports an empty assignment as no secret', () => {
    assert.equal(dotenvTestOtpSecret('TEST_OTP_SECRET=\n'), '');
  });

  it('reports an absent assignment as no secret', () => {
    assert.equal(dotenvTestOtpSecret('DATABASE_URL=postgres://x\n'), '');
  });
});

describe('resolveTestOtpSecret', () => {
  it('prefers an already-exported secret over every candidate file', () => {
    assert.equal(resolveTestOtpSecret('exported', ['TEST_OTP_SECRET=fromfile\n']), 'exported');
  });

  it('skips a candidate file that does not exist', () => {
    assert.equal(resolveTestOtpSecret('', [undefined, 'TEST_OTP_SECRET=home\n']), 'home');
  });

  it('falls through a candidate whose assignment is empty', () => {
    const secret = resolveTestOtpSecret('', ['TEST_OTP_SECRET=\n', 'TEST_OTP_SECRET=home\n']);
    assert.equal(secret, 'home');
  });

  it('returns nothing when no candidate names a secret', () => {
    assert.equal(resolveTestOtpSecret('', [undefined, 'OTHER=1\n']), '');
  });
});

describe('secretIsBlank', () => {
  it('treats a whitespace-only secret as absent, so the lane mints its own', () => {
    assert.equal(secretIsBlank(' \t\n'), true);
  });

  it('treats an empty secret as absent', () => {
    assert.equal(secretIsBlank(''), true);
  });

  it('keeps a secret that merely has padding', () => {
    assert.equal(secretIsBlank('  abc  '), false);
  });
});

describe('dotenvSource', () => {
  it('reuses a .env that is already in the workspace', () => {
    const source = dotenvSource({
      dotenvPresent: true,
      homeDotenvPresent: true,
      encodedDotenvPresent: true,
    });
    assert.equal(source, 'present');
  });

  it('prefers the runner-local dev env over the encoded secret', () => {
    const source = dotenvSource({
      dotenvPresent: false,
      homeDotenvPresent: true,
      encodedDotenvPresent: true,
    });
    assert.equal(source, 'copy-home-dotenv');
  });

  it('decodes the secret when the runner has no dev env of its own', () => {
    const source = dotenvSource({
      dotenvPresent: false,
      homeDotenvPresent: false,
      encodedDotenvPresent: true,
    });
    assert.equal(source, 'decode-secret');
  });

  it('fails closed when no source can supply credentials', () => {
    const source = dotenvSource({
      dotenvPresent: false,
      homeDotenvPresent: false,
      encodedDotenvPresent: false,
    });
    assert.equal(source, 'unavailable');
  });
});

describe('dependencyInstallRequired', () => {
  it('reinstalls a node_modules that is missing Next, not just missing entirely', () => {
    const required = dependencyInstallRequired({
      nodeModulesPresent: true,
      nextBinaryExecutable: false,
    });
    assert.equal(required, true);
  });

  it('reinstalls when node_modules is absent', () => {
    const required = dependencyInstallRequired({
      nodeModulesPresent: false,
      nextBinaryExecutable: false,
    });
    assert.equal(required, true);
  });

  it('reuses a complete install', () => {
    const required = dependencyInstallRequired({
      nodeModulesPresent: true,
      nextBinaryExecutable: true,
    });
    assert.equal(required, false);
  });
});

describe('incomeProviderAuditLog', () => {
  it('fails closed when the audited lane has no log path to write evidence to', () => {
    assert.throws(() => incomeProviderAuditLog('income', ''), /INCOME_E2E_PROVIDER_AUDIT_LOG/);
  });

  it('returns nothing for a lane that does not audit provider calls', () => {
    assert.equal(incomeProviderAuditLog('onboarding', ''), '');
  });

  it('ignores a log path set for a lane that does not audit', () => {
    assert.equal(incomeProviderAuditLog('budget', '/tmp/audit.jsonl'), '');
  });

  it('returns the audited lane`s log path', () => {
    assert.equal(incomeProviderAuditLog('income', '/tmp/audit.jsonl'), '/tmp/audit.jsonl');
  });
});

describe('probeEmail', () => {
  it('falls back to the local defaults outside Actions', () => {
    assert.equal(probeEmail({ runId: '', runAttempt: '' }), 'health-local-0@test.example.local');
  });

  it('separates run attempts, so a rerun does not reuse the previous probe identity', () => {
    const first = probeEmail({ runId: '7', runAttempt: '1' });
    const second = probeEmail({ runId: '7', runAttempt: '2' });
    assert.notEqual(first, second);
  });
});

describe('metadataProbeSatisfied', () => {
  const expected = { repositoryRoot: '/w/example', buildSha: 'abc123' };
  const ready = {
    ready: true,
    nodeEnv: 'development',
    repositoryRoot: '/w/example',
    buildSha: 'abc123',
  };

  it('accepts the checked-out backend', () => {
    assert.equal(metadataProbeSatisfied(ready, expected), true);
  });

  it('rejects a healthy listener from another worktree', () => {
    const other = { ...ready, repositoryRoot: '/w/other' };
    assert.equal(metadataProbeSatisfied(other, expected), false);
  });

  it('rejects a backend built from a different commit', () => {
    assert.equal(metadataProbeSatisfied({ ...ready, buildSha: 'def456' }, expected), false);
  });

  it('rejects a production-mode backend, where the test endpoints are not mounted', () => {
    assert.equal(metadataProbeSatisfied({ ...ready, nodeEnv: 'production' }, expected), false);
  });

  it('rejects a truthy-but-not-true ready flag', () => {
    assert.equal(metadataProbeSatisfied({ ...ready, ready: 'yes' }, expected), false);
  });

  it('rejects a payload that is not an object', () => {
    assert.equal(metadataProbeSatisfied('ready', expected), false);
    assert.equal(metadataProbeSatisfied(null, expected), false);
    assert.equal(metadataProbeSatisfied([ready], expected), false);
  });

  it('rejects a payload missing the fields entirely', () => {
    assert.equal(metadataProbeSatisfied({}, expected), false);
  });
});

describe('otpProbeConfirmed', () => {
  it('requires a strict true', () => {
    assert.equal(otpProbeConfirmed({ confirmed: true }), true);
    assert.equal(otpProbeConfirmed({ confirmed: 'true' }), false);
    assert.equal(otpProbeConfirmed({ confirmed: 1 }), false);
  });

  it('rejects a non-object payload', () => {
    assert.equal(otpProbeConfirmed(null), false);
    assert.equal(otpProbeConfirmed([{ confirmed: true }]), false);
  });
});

describe('readinessVerdict', () => {
  it('proceeds to the probe only on a reported ready line', () => {
    assert.equal(readinessVerdict('ready'), 'ready');
  });

  it('treats the supervisor giving up as not ready', () => {
    assert.equal(readinessVerdict('giving-up'), 'not-ready');
  });
});

describe('isDevServerReadyLine', () => {
  it('matches the dev server announcing itself', () => {
    assert.equal(isDevServerReadyLine('   ▲ Next.js  — Ready in 900ms'), true);
  });

  it('does not mistake a restart record for readiness', () => {
    const line = '[2026-09-20T00:00:00Z] supervisor: dev backend exited with 1 (restart 1/6)';
    assert.equal(isDevServerReadyLine(line), false);
  });

  it('does not mistake the supervisor giving up for readiness', () => {
    assert.equal(isDevServerReadyLine('supervisor: giving up after 6 restarts'), false);
  });

  it('is anchored on the same pattern the supervisor scans with', () => {
    assert.equal(devServerReadyPattern.test('Ready in 1s'), true);
  });
});

describe('splitCompleteLines', () => {
  it('holds back a line the backend has not finished writing', () => {
    const split = splitCompleteLines('', 'done\n ✓ Ready in 90');
    assert.deepEqual([...split.lines], ['done']);
    assert.equal(split.remainder, ' ✓ Ready in 90');
  });

  it('joins a line split across two chunks, so a ready line is never missed', () => {
    const first = splitCompleteLines('', ' ✓ Ready in 90');
    const second = splitCompleteLines(first.remainder, '0ms\n');
    assert.deepEqual([...second.lines], [' ✓ Ready in 900ms']);
    assert.equal(second.remainder, '');
  });

  it('yields every complete line in a multi-line chunk', () => {
    const split = splitCompleteLines('', 'a\nb\nc\n');
    assert.deepEqual([...split.lines], ['a', 'b', 'c']);
  });

  it('yields nothing for a chunk with no newline', () => {
    const split = splitCompleteLines('', 'partial');
    assert.deepEqual([...split.lines], []);
    assert.equal(split.remainder, 'partial');
  });
});

describe('tailLines', () => {
  it('returns the last lines without the empty tail a trailing newline creates', () => {
    assert.equal(tailLines('a\nb\nc\n', 2), 'b\nc');
  });

  it('returns everything when the log is shorter than the window', () => {
    assert.equal(tailLines('a\nb', 80), 'a\nb');
  });

  it('returns nothing for an empty log', () => {
    assert.equal(tailLines('', 80), '');
  });

  it('keeps a final line that has no newline after it', () => {
    assert.equal(tailLines('a\nb\nc', 1), 'c');
  });
});

describe('processGroupIsolated', () => {
  it('refuses a supervisor that inherited the step`s process group', () => {
    assert.equal(processGroupIsolated(4242, 100), false);
  });

  it('accepts a session leader', () => {
    assert.equal(processGroupIsolated(4242, 4242), true);
  });
});

describe('supervisorMarkers', () => {
  it('records the supervisor PID as the process group the cleanup may stop', () => {
    const markers = supervisorMarkers({
      supervisorPid: 4242,
      pidFile: '/tmp/backend.pid',
      backendLog: '/tmp/devserver.log',
      supervisorLog: '/tmp/supervisor.log',
    });
    assert.equal(markers.ONBOARDING_DEV_BACKEND_SUPERVISOR_PID, '4242');
    assert.equal(markers.ONBOARDING_DEV_BACKEND_PROCESS_GROUP_ID, '4242');
    assert.equal(markers.ONBOARDING_DEV_BACKEND_PID_FILE, '/tmp/backend.pid');
  });

  it('exports no marker the cleanup does not read', () => {
    const markers = supervisorMarkers({
      supervisorPid: 1,
      pidFile: 'p',
      backendLog: 'b',
      supervisorLog: 's',
    });
    assert.deepEqual(Object.keys(markers).sort(), [
      'ONBOARDING_DEV_BACKEND_LOG',
      'ONBOARDING_DEV_BACKEND_PID_FILE',
      'ONBOARDING_DEV_BACKEND_PROCESS_GROUP_ID',
      'ONBOARDING_DEV_BACKEND_SUPERVISOR_LOG',
      'ONBOARDING_DEV_BACKEND_SUPERVISOR_PID',
    ]);
  });
});

describe('backendCommand', () => {
  it('passes the port as its own argument, never interpolated into a shell string', () => {
    const { command, args } = backendCommand(3100);
    assert.equal(command, 'npm');
    assert.deepEqual([...args], [
      'run', 'dev', '--', '--webpack', '--hostname', '127.0.0.1', '--port', '3100',
    ]);
  });

  it('keeps a hostile port value inert as a single argument', () => {
    const { args } = backendCommand(Number.NaN);
    assert.equal(args.at(-1), 'NaN');
  });
});

describe('backendEnvironment', () => {
  const base = { PATH: '/usr/bin', NODE_OPTIONS: '--max-old-space-size=4096' };

  it('pins the development runtime the test endpoints require', () => {
    const environment = backendEnvironment({
      base,
      port: 3000,
      expectedBuildSha: 'abc',
      repositoryRoot: '/w/example',
      externalProviderAuditLog: '',
    });
    assert.equal(environment.NODE_ENV, 'development');
    assert.equal(environment.PORT, '3000');
    assert.equal(environment.HOSTNAME, '127.0.0.1');
    assert.equal(environment.EXAMPLE_BUILD_SHA, 'abc');
  });

  it('leaves the audit hook out of a lane that does not audit provider calls', () => {
    const environment = backendEnvironment({
      base,
      port: 3000,
      expectedBuildSha: 'abc',
      repositoryRoot: '/w/example',
      externalProviderAuditLog: '',
    });
    assert.equal(environment.NODE_OPTIONS, '--max-old-space-size=4096');
    assert.equal(environment.EXTERNAL_PROVIDER_AUDIT_LOG, undefined);
    assert.equal(environment.ENABLE_VECTOR_TOOL_SELECTION, undefined);
  });

  it('appends the audit hook without dropping options the runner already set', () => {
    const environment = backendEnvironment({
      base,
      port: 3300,
      expectedBuildSha: 'abc',
      repositoryRoot: '/w/example',
      externalProviderAuditLog: '/tmp/audit.jsonl',
    });
    assert.equal(
      environment.NODE_OPTIONS,
      '--max-old-space-size=4096 --import=/w/example/ci/src/actions/ios/externalProviderAuditHook.ts',
    );
    assert.equal(environment.EXTERNAL_PROVIDER_AUDIT_POLICY, 'block');
  });

  it('does not leave a leading space when the runner set no options', () => {
    const environment = backendEnvironment({
      base: { PATH: '/usr/bin' },
      port: 3300,
      expectedBuildSha: 'abc',
      repositoryRoot: '/w/example',
      externalProviderAuditLog: '/tmp/audit.jsonl',
    });
    assert.equal(
      environment.NODE_OPTIONS,
      '--import=/w/example/ci/src/actions/ios/externalProviderAuditHook.ts',
    );
  });

  it('disables the startup tasks that would dial OpenAI and be recorded as an escape', () => {
    const environment = backendEnvironment({
      base,
      port: 3300,
      expectedBuildSha: 'abc',
      repositoryRoot: '/w/example',
      externalProviderAuditLog: '/tmp/audit.jsonl',
    });
    assert.equal(environment.ENABLE_VECTOR_TOOL_SELECTION, 'false');
    assert.equal(environment.ENABLE_SCHEDULER_ORCHESTRATOR, 'false');
  });

  it('drops variables the parent left unset rather than passing "undefined"', () => {
    const environment = backendEnvironment({
      base: { PATH: '/usr/bin', EMPTY: undefined },
      port: 3000,
      expectedBuildSha: 'abc',
      repositoryRoot: '/w/example',
      externalProviderAuditLog: '',
    });
    assert.equal('EMPTY' in environment, false);
  });
});

describe('supervisorRestartVerdict', () => {
  it('gives up exactly at the bound, not after it', () => {
    assert.equal(supervisorRestartVerdict(maxBackendRestarts, maxBackendRestarts), 'give-up');
    assert.equal(supervisorRestartVerdict(maxBackendRestarts - 1, maxBackendRestarts), 'restart');
  });

  it('keeps the bound at six, which the supervisor contract test reads', () => {
    assert.equal(maxBackendRestarts, 6);
  });
});

describe('backendExitStatus', () => {
  it('reports the exit code when the backend exited on its own', () => {
    assert.equal(backendExitStatus(3, null, {}), 3);
  });

  it('reports 128 plus the signal, as wait did for a signalled child', () => {
    assert.equal(backendExitStatus(null, 'SIGTERM', { SIGTERM: 15 }), 143);
  });

  it('falls back to 128 for a signal it cannot number', () => {
    assert.equal(backendExitStatus(null, 'SIGWEIRD', {}), 128);
  });

  it('reports success when neither a code nor a signal is reported', () => {
    assert.equal(backendExitStatus(null, null, {}), 0);
  });
});

describe('supervisor log lines', () => {
  const timestamp = '2026-09-20T12:00:00Z';

  it('stamps a timestamp the readiness wait and the diagnostics both parse', () => {
    assert.equal(supervisorTimestamp(new Date('2026-09-20T12:00:00.123Z')), timestamp);
  });

  it('writes the exit record the readiness wait must not mistake for a verdict', () => {
    const line = backendExitedDevserverLine({
      timestamp,
      status: 1,
      restarts: 1,
      maxRestarts: 6,
    });
    assert.equal(line, `[${timestamp}] supervisor: dev backend exited with 1 (restart 1/6)`);
    assert.equal(isDevServerReadyLine(line), false);
  });

  it('writes the supervisor-log twin without the "supervisor:" prefix', () => {
    const line = backendExitedSupervisorLine({
      timestamp,
      status: 1,
      restarts: 2,
      maxRestarts: 6,
    });
    assert.equal(line, `[${timestamp}] dev backend exited with 1 (restart 2/6)`);
  });

  it('writes the giving-up record the step reports as the failure reason', () => {
    const line = givingUpDevserverLine(timestamp, 6);
    assert.equal(line, `[${timestamp}] supervisor: giving up after 6 restarts`);
    assert.equal(isDevServerReadyLine(line), false);
  });

  it('writes the supervisor-log giving-up twin', () => {
    assert.equal(givingUpSupervisorLine(timestamp, 6), `[${timestamp}] giving up after 6 restarts`);
  });

  it('names the lane port in the start record, never a hard-coded 3000', () => {
    const line = startingBackendDevserverLine(timestamp, 3200);
    assert.equal(line, `[${timestamp}] supervisor starting dev backend on 127.0.0.1:3200`);
  });

  it('lists every stale listener it force-stops', () => {
    const line = forceStoppingListenersLine(timestamp, 3100, [11, 22]);
    assert.equal(line, `[${timestamp}] force-stopping :3100 listener(s): 11 22`);
  });
});
