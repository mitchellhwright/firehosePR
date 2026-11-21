import assert from 'node:assert/strict';
import { accessSync, constants, readdirSync, readFileSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { delimiter, join } from 'node:path';

export function requireRuntimeIdentity(uid: number, gid: number): void {
  assert.equal(uid, 10001);
  assert.equal(gid, 10001);
}

export function requireRuntimeStatus(status: string): void {
  assert.match(status, /^CapEff:\s+0+$/m);
  assert.match(status, /^NoNewPrivs:\s+1$/m);
}

export async function requireHealthyResponse(request: typeof fetch = fetch): Promise<void> {
  const response = await request('http://127.0.0.1:8080/health', { signal: AbortSignal.timeout(5000) });
  assert.equal(response.ok, true, `unexpected /health response ${response.status}`);
  const body: unknown = await response.json();
  assert.ok(body !== null && typeof body === 'object' && !Array.isArray(body)
    && 'status' in body && body.status === 'ok', 'unexpected /health body');
}

export async function requireHealthyHead(request: typeof fetch = fetch): Promise<void> {
  const response = await request('http://127.0.0.1:8080/health', {
    method: 'HEAD', signal: AbortSignal.timeout(2000),
  });
  assert.equal(response.status, 200, `unexpected /health HEAD response ${response.status}`);
}

function requireIdentity(): void {
  assert.ok(process.getuid && process.getgid, 'Linux process identity is required');
  requireRuntimeIdentity(process.getuid(), process.getgid());
}

function requireImagePermissions(): void {
  requireIdentity();
  for (const path of ['/app', '/app/server.js', '/etc', '/tmp']) {
    assert.throws(() => writeFileSync(`${path}/.example-permission-test`, 'denied'), { code: /EACCES|ENOTDIR/ });
  }
  for (const path of ['/tmp/example', '/app/.next/cache']) {
    const probe = `${path}/.example-permission-test`;
    writeFileSync(probe, 'ok');
    unlinkSync(probe);
  }
  const server = statSync('/app/server.js');
  assert.equal(server.uid, 0);
  assert.equal(server.mode & 0o022, 0);
  assert.equal(process.env.HOME, '/tmp/example');
  assert.equal(process.env.TMPDIR, '/tmp/example');
}

function requireNoPackageManagers(): void {
  for (const executable of ['npm', 'npx', 'corepack']) {
    for (const directory of (process.env.PATH ?? '').split(delimiter).filter(Boolean)) {
      let executablePresent = false;
      try { accessSync(join(directory, executable), constants.X_OK); executablePresent = true; }
      catch (error) {
        if (!(error instanceof Error && 'code' in error
          && ['ENOENT', 'ENOTDIR', 'EACCES'].includes(String(error.code)))) throw error;
      }
      assert.equal(executablePresent, false, `runtime contains ${executable}`);
    }
  }
  const pending = ['/app'];
  while (pending.length > 0) {
    const directory = pending.pop();
    assert.ok(directory);
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      assert.ok(!['.npmrc', '.yarnrc', '.yarnrc.yml'].includes(entry.name),
        `runtime contains package-manager configuration ${join(directory, entry.name)}`);
      if (entry.isDirectory()) pending.push(join(directory, entry.name));
    }
  }
}

function requireRuntimePermissions(): void {
  requireIdentity();
  requireRuntimeStatus(readFileSync('/proc/1/status', 'utf8'));
  writeFileSync('/tmp/example/runtime-probe', 'ok');
  writeFileSync('/app/.next/cache/runtime-probe', 'ok');
  assert.throws(() => writeFileSync('/app/runtime-probe', 'denied'), { code: 'EROFS' });
}

export async function primaryContainerProbe(args: readonly string[]): Promise<void> {
  assert.equal(args.length, 1, 'exactly one probe mode is required');
  switch (args[0]) {
    case 'image-permissions': requireImagePermissions(); return;
    case 'package-managers': requireNoPackageManagers(); return;
    case 'runtime-permissions': requireRuntimePermissions(); return;
    case 'health': await requireHealthyResponse(); return;
    case 'head': await requireHealthyHead(); return;
    default: throw new Error(`Unknown primary container probe: ${args[0]}`);
  }
}

// Docker's Node receives this dependency-free module on stdin. No runtime image
// mutation, package-manager install, bind mount or generated JavaScript is needed.
if (process.argv[1] === '-') {
  primaryContainerProbe(process.argv.slice(2)).catch(error => {
    console.error(error);
    process.exitCode = 1;
  });
}
