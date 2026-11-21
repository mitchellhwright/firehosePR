import assert from 'node:assert/strict';
import { once } from 'node:events';
import { spawn, spawnSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const helperPath = fileURLToPath(
  new URL('../../scripts/prepare-local-gcp-adc.sh', import.meta.url)
);
const realJqPath = spawnSync('which', ['jq'], { encoding: 'utf8' }).stdout.trim();

interface TestFixture {
  accountDirectory: string;
  applicationDefaultPath: string;
  binDirectory: string;
  commandLog: string;
  env: NodeJS.ProcessEnv & { TMPDIR: string };
  root: string;
  runtimeDirectory: string;
}

interface SavedCredential {
  account?: string;
  client_id: string;
  client_secret: string;
  refresh_token: string;
  type: 'authorized_user';
}

function createFixture(
  { activeAccount = 'developer@example.invalid' }: { activeAccount?: string } = {},
): TestFixture {
  const root = mkdtempSync(join(tmpdir(), 'example-gcp-adc-test-'));
  const binDirectory = join(root, 'bin');
  const gcloudConfig = join(root, 'gcloud');
  const applicationDefaultPath = join(
    gcloudConfig,
    'application_default_credentials.json'
  );
  const runtimeDirectory = join(root, 'runtime');
  const savedAccount = 'developer@example.invalid';
  const accountDirectory = join(gcloudConfig, 'legacy_credentials', savedAccount);
  const commandLog = join(root, 'gcloud-commands.log');

  mkdirSync(binDirectory, { recursive: true });
  mkdirSync(accountDirectory, { recursive: true });
  mkdirSync(runtimeDirectory, { recursive: true });

  const fakeGcloud = join(binDirectory, 'gcloud');
  writeFileSync(
    fakeGcloud,
    `#!/usr/bin/env bash
set -euo pipefail
printf '%s\\n' "$*" >> "${commandLog}"
if [[ "$1" == "config" && "$2" == "get-value" && "$3" == "account" ]]; then
  printf '%s\\n' "${activeAccount}"
  exit 0
fi
if [[ "$1" == "sql" && "$2" == "instances" && "$3" == "describe" ]]; then
  if [[ -z "\${CLOUDSDK_AUTH_CREDENTIAL_FILE_OVERRIDE:-}" && "\${EXAMPLE_TEST_DENIED_ACTIVE:-}" == "1" ]]; then
    printf 'PERMISSION_DENIED: active account cannot impersonate in test fixture\n' >&2
    exit 1
  fi
  if [[ -n "\${EXAMPLE_TEST_DENIED_ADC:-}" && "\${CLOUDSDK_AUTH_CREDENTIAL_FILE_OVERRIDE:-}" == "\${EXAMPLE_TEST_DENIED_ADC}" ]]; then
    printf 'PERMISSION_DENIED: iam.serviceAccounts.getAccessToken denied for test fixture\n' >&2
    exit 1
  fi
  printf 'test-access-token\\n'
  exit 0
fi
exit 64
`
  );
  chmodSync(fakeGcloud, 0o755);

  return {
    accountDirectory,
    applicationDefaultPath,
    binDirectory,
    commandLog,
    env: {
      ...process.env,
      CLOUDSDK_CONFIG: gcloudConfig,
      PATH: `${binDirectory}:${process.env.PATH ?? ''}`,
      TMPDIR: runtimeDirectory,
    },
    root,
    runtimeDirectory,
  };
}

function validCredential(account?: string): SavedCredential {
  return {
    ...(account ? { account } : {}),
    client_id: 'saved-client-id',
    client_secret: 'saved-client-secret',
    refresh_token: 'saved-refresh-token',
    type: 'authorized_user',
  };
}

function runHelper(fixture: TestFixture, additionalEnv: NodeJS.ProcessEnv = {}) {
  return spawnSync('bash', [helperPath], {
    encoding: 'utf8',
    env: { ...fixture.env, ...additionalEnv },
  });
}

function runtimeFiles(fixture: TestFixture): string[] {
  return readdirSync(fixture.runtimeDirectory)
    .filter((entry) => entry.startsWith('example-gcp-adc.'));
}

function requireProcessId(processId: number | undefined): number {
  if (processId === undefined) {
    throw new Error('Spawned helper did not expose a process id');
  }
  return processId;
}

function killProcessGroup(processId: number | undefined): void {
  try {
    process.kill(-requireProcessId(processId), 'SIGKILL');
  } catch (error) {
    if (!(error instanceof Error && 'code' in error && error.code === 'ESRCH')) {
      throw error;
    }
  }
}

async function waitForRuntimeFile(fixture: TestFixture, timeoutMs = 5000): Promise<string[]> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const files = runtimeFiles(fixture);
    if (files.length > 0) {
      return files;
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error('runtime ADC file was not created before timeout');
}

async function waitForFile(
  filePath: string,
  description: string,
  timeoutMs = 5000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (existsSync(filePath)) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`${description} was not created before timeout`);
}

test('prefers the canonical refreshed ADC over the legacy account copy', () => {
  const fixture = createFixture();
  const canonicalCredential = {
    ...validCredential('developer@example.invalid'),
    refresh_token: 'canonical-refresh-token',
  };
  const legacyCredential = {
    ...validCredential(),
    refresh_token: 'stale-legacy-refresh-token',
  };
  writeFileSync(
    fixture.applicationDefaultPath,
    `${JSON.stringify(canonicalCredential)}\n`,
    { mode: 0o600 }
  );
  writeFileSync(
    join(fixture.accountDirectory, 'adc.json'),
    `${JSON.stringify(legacyCredential)}\n`,
    { mode: 0o600 }
  );

  try {
    const result = runHelper(fixture);

    assert.equal(result.status, 0, result.stderr);
    const runtimePath = result.stdout.trim();
    assert.deepEqual(JSON.parse(readFileSync(runtimePath, 'utf8')), {
      ...canonicalCredential,
      quota_project_id: 'example-app',
    });
    assert.equal(result.stdout.includes(canonicalCredential.refresh_token), false);
    assert.equal(result.stderr.includes(canonicalCredential.refresh_token), false);
    assert.match(
      readFileSync(fixture.commandLog, 'utf8'),
      /sql instances describe example-dev-postgres --account=developer@example.invalid --impersonate-service-account=example-local-dev@example-app\.iam\.gserviceaccount\.com --project=example-app --format=value\(connectionName\) --quiet/
    );

    rmSync(runtimePath, { force: true });
  } finally {
    rmSync(fixture.root, { force: true, recursive: true });
  }
});

test('accepts a canonical ADC without account metadata after both access proofs', () => {
  const fixture = createFixture();
  const canonicalCredential = validCredential();
  writeFileSync(
    fixture.applicationDefaultPath,
    `${JSON.stringify(canonicalCredential)}\n`,
    { mode: 0o600 }
  );

  try {
    const result = runHelper(fixture);

    assert.equal(result.status, 0, result.stderr);
    const runtimePath = result.stdout.trim();
    assert.deepEqual(JSON.parse(readFileSync(runtimePath, 'utf8')), {
      ...canonicalCredential,
      quota_project_id: 'example-app',
    });
    assert.equal(readFileSync(fixture.commandLog, 'utf8').match(/sql instances describe/g)?.length, 2);
    rmSync(runtimePath, { force: true });
  } finally {
    rmSync(fixture.root, { force: true, recursive: true });
  }
});

test('rejects metadata-free ADC when the active account cannot impersonate', () => {
  const fixture = createFixture();
  writeFileSync(
    fixture.applicationDefaultPath,
    `${JSON.stringify(validCredential())}\n`,
    { mode: 0o600 }
  );

  try {
    const result = runHelper(fixture, { EXAMPLE_TEST_DENIED_ACTIVE: '1' });

    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /active account cannot impersonate/);
    assert.deepEqual(runtimeFiles(fixture), []);
    assert.equal(readFileSync(fixture.commandLog, 'utf8').match(/sql instances describe/g)?.length, 1);
  } finally {
    rmSync(fixture.root, { force: true, recursive: true });
  }
});

test('falls back to the active account legacy ADC when canonical ADC is absent', () => {
  const fixture = createFixture();
  const sourcePath = join(fixture.accountDirectory, 'adc.json');
  const sourceCredential = validCredential();
  writeFileSync(sourcePath, `${JSON.stringify(sourceCredential)}\n`, { mode: 0o600 });

  try {
    const result = runHelper(fixture);

    assert.equal(result.status, 0, result.stderr);
    const runtimePath = result.stdout.trim();
    assert.ok(runtimePath.startsWith(fixture.env.TMPDIR));
    assert.deepEqual(JSON.parse(readFileSync(runtimePath, 'utf8')), {
      ...sourceCredential,
      quota_project_id: 'example-app',
    });
    assert.equal(statSync(runtimePath).mode & 0o777, 0o600);
    assert.deepEqual(JSON.parse(readFileSync(sourcePath, 'utf8')), sourceCredential);
    assert.equal(result.stdout.includes(sourceCredential.refresh_token), false);
    assert.equal(result.stderr.includes(sourceCredential.refresh_token), false);
    assert.equal(
      readFileSync(fixture.commandLog, 'utf8').trim(),
      [
        'config get-value account --quiet',
        'sql instances describe example-dev-postgres --account=developer@example.invalid --impersonate-service-account=example-local-dev@example-app.iam.gserviceaccount.com --project=example-app --format=value(connectionName) --quiet',
      ].join('\n')
    );

    rmSync(runtimePath, { force: true });
  } finally {
    rmSync(fixture.root, { force: true, recursive: true });
  }
});

test('rejects a canonical ADC for another account and falls back to the active account legacy ADC', () => {
  const fixture = createFixture();
  const canonicalCredential = validCredential('different@example.invalid');
  const legacyCredential = validCredential();
  writeFileSync(
    fixture.applicationDefaultPath,
    `${JSON.stringify(canonicalCredential)}\n`,
    { mode: 0o600 }
  );
  writeFileSync(
    join(fixture.accountDirectory, 'adc.json'),
    `${JSON.stringify(legacyCredential)}\n`,
    { mode: 0o600 }
  );

  try {
    const result = runHelper(fixture);

    assert.equal(result.status, 0, result.stderr);
    const runtimePath = result.stdout.trim();
    assert.deepEqual(JSON.parse(readFileSync(runtimePath, 'utf8')), {
      ...legacyCredential,
      quota_project_id: 'example-app',
    });
    const commands = readFileSync(fixture.commandLog, 'utf8');
    assert.equal(commands.match(/sql instances describe/g)?.length, 1);
    rmSync(runtimePath, { force: true });
  } finally {
    rmSync(fixture.root, { force: true, recursive: true });
  }
});

test('fails closed when no saved ADC can impersonate the local development service account', () => {
  const fixture = createFixture();
  const sourcePath = join(fixture.accountDirectory, 'adc.json');
  writeFileSync(sourcePath, `${JSON.stringify(validCredential())}\n`, { mode: 0o600 });

  try {
    const result = runHelper(fixture, { EXAMPLE_TEST_DENIED_ADC: sourcePath });

    assert.notEqual(result.status, 0);
    assert.match(
      result.stderr,
      /PERMISSION_DENIED: iam\.serviceAccounts\.getAccessToken denied for test fixture/
    );
    assert.match(result.stderr, /cannot impersonate/i);
    assert.deepEqual(runtimeFiles(fixture), []);
  } finally {
    rmSync(fixture.root, { force: true, recursive: true });
  }
});

test('fails without mutating auth when the active account has no saved ADC', () => {
  const fixture = createFixture();

  try {
    const result = runHelper(fixture);

    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /saved ADC credential was not found/i);
    assert.equal(
      readFileSync(fixture.commandLog, 'utf8').trim(),
      'config get-value account --quiet'
    );
    assert.deepEqual(runtimeFiles(fixture), []);
  } finally {
    rmSync(fixture.root, { force: true, recursive: true });
  }
});

test('rejects an unsafe active account before resolving a credential path', () => {
  const fixture = createFixture({ activeAccount: '../../etc/passwd' });

  try {
    const result = runHelper(fixture);

    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /not a safe credential path/i);
    assert.deepEqual(runtimeFiles(fixture), []);
  } finally {
    rmSync(fixture.root, { force: true, recursive: true });
  }
});

test('rejects incomplete saved credentials without creating a runtime copy', () => {
  const fixture = createFixture();
  writeFileSync(
    join(fixture.accountDirectory, 'adc.json'),
    `${JSON.stringify({ type: 'service_account' })}\n`,
    { mode: 0o600 }
  );

  try {
    const result = runHelper(fixture);

    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /incomplete or invalid/i);
    assert.deepEqual(runtimeFiles(fixture), []);
  } finally {
    rmSync(fixture.root, { force: true, recursive: true });
  }
});

test('reports a missing required tool before inspecting credentials', () => {
  const fixture = createFixture();
  const bashEnv = join(fixture.root, 'missing-tool-env.sh');
  writeFileSync(
    bashEnv,
    `command() {
  if [ "\${1:-}" = '-v' ] && [ "\${2:-}" = 'jq' ]; then
    return 1
  fi
  builtin command "$@"
}
`
  );

  try {
    const result = runHelper(fixture, { BASH_ENV: bashEnv });

    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /jq is required/i);
    assert.deepEqual(runtimeFiles(fixture), []);
  } finally {
    rmSync(fixture.root, { force: true, recursive: true });
  }
});

test('removes the runtime copy when quota scoping fails', () => {
  assert.ok(realJqPath, 'jq must be installed to exercise the helper failure path');
  const fixture = createFixture();
  writeFileSync(
    join(fixture.accountDirectory, 'adc.json'),
    `${JSON.stringify(validCredential())}\n`,
    { mode: 0o600 }
  );
  const fakeJq = join(fixture.binDirectory, 'jq');
  writeFileSync(
    fakeJq,
    `#!/usr/bin/env bash
if [[ "\${1:-}" == '-e' ]]; then
  exec "${realJqPath}" "$@"
fi
exit 73
`
  );
  chmodSync(fakeJq, 0o755);

  try {
    const result = runHelper(fixture);

    assert.equal(result.status, 73);
    assert.deepEqual(runtimeFiles(fixture), []);
  } finally {
    rmSync(fixture.root, { force: true, recursive: true });
  }
});

test('removes the runtime copy when interrupted', async () => {
  assert.ok(realJqPath, 'jq must be installed to exercise the helper signal path');
  const fixture = createFixture();
  writeFileSync(
    join(fixture.accountDirectory, 'adc.json'),
    `${JSON.stringify(validCredential())}\n`,
    { mode: 0o600 }
  );
  const fakeJq = join(fixture.binDirectory, 'jq');
  const jqReadyFile = join(fixture.root, 'jq-ready');
  writeFileSync(
    fakeJq,
    `#!/usr/bin/env bash
if [[ "\${1:-}" == '-e' ]]; then
  exec "${realJqPath}" "$@"
fi
printf 'ready\n' > "${jqReadyFile}"
trap 'exit 143' TERM
sleep 30
`
  );
  chmodSync(fakeJq, 0o755);

  const child = spawn('bash', [helperPath], {
    detached: true,
    env: fixture.env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  try {
    await waitForRuntimeFile(fixture);
    await waitForFile(jqReadyFile, 'fake jq readiness marker');
    process.kill(-requireProcessId(child.pid), 'SIGTERM');
    await once(child, 'close');
    assert.deepEqual(runtimeFiles(fixture), []);
  } finally {
    if (child.exitCode === null && child.signalCode === null) {
      killProcessGroup(child.pid);
      await once(child, 'close');
    }
    rmSync(fixture.root, { force: true, recursive: true });
  }
});
