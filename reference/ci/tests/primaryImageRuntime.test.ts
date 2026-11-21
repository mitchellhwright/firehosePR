import assert from 'node:assert/strict';
import test from 'node:test';
import { createServer } from 'node:http';
import { chmod, lstat, mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { preparePrimaryImagePaths, verifyPrimaryDependencies } from '../cloudbuild/runtime/primaryImageSetup.ts';
import { primaryHealthUrl, primaryImageHealthy } from '../cloudbuild/runtime/primaryImageHealth.ts';

test('image preparation keeps code immutable, writable paths private and symlinks contained', async () => {
  const root = await mkdtemp(join(tmpdir(), 'primary-image-'));
  try {
    const app = join(root, 'app');
    const temporary = join(root, 'tmp/example');
    await mkdir(join(app, '.next/cache'), { recursive: true });
    await writeFile(join(app, 'server.js'), 'code');
    await writeFile(join(app, '.next/cache/asset'), 'cache');
    const outside = join(root, 'outside');
    await writeFile(outside, 'external');
    for (const path of [app, join(app, 'server.js'), outside]) await chmod(path, 0o777);
    await symlink(outside, join(app, 'external'));
    await symlink(outside, join(app, '.next/cache/external'));
    const owners: { path: string; uid: number; gid: number; symlink: boolean }[] = [];
    await preparePrimaryImagePaths(app, temporary, {
      chown: async (path, uid, gid) => { owners.push({ path: String(path), uid, gid, symlink: false }); },
      lchown: async (path, uid, gid) => { owners.push({ path: String(path), uid, gid, symlink: true }); },
    });
    assert.equal((await lstat(app)).mode & 0o777, 0o755);
    assert.equal((await lstat(join(app, 'server.js'))).mode & 0o022, 0);
    for (const path of [join(app, '.next/cache'), temporary, join(temporary, 'cache'), join(temporary, 'config')]) {
      assert.equal((await lstat(path)).mode & 0o777, 0o700);
      assert.ok(owners.some(owner => owner.path === path && owner.uid === 10001 && owner.gid === 10001));
    }
    assert.ok(owners.some(owner => owner.path.endsWith('/cache/external') && owner.symlink));
    assert.equal((await lstat(outside)).mode & 0o777, 0o777);
    assert.equal(owners.some(owner => owner.path === outside || owner.path === join(app, 'server.js')), false);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('large cache trees bound concurrent ownership work without omitting files', async () => {
  const root = await mkdtemp(join(tmpdir(), 'primary-image-capacity-'));
  try {
    const app = join(root, 'app');
    const cache = join(app, '.next/cache');
    await mkdir(cache, { recursive: true });
    const files = Array.from({ length: 100 }, (_, index) => join(cache, String(index)));
    await Promise.all(files.map(path => writeFile(path, 'cached')));
    let active = 0;
    let maximum = 0;
    const changed = new Set<string>();
    const own = async (path: Parameters<typeof chmod>[0]): Promise<void> => {
      active += 1;
      maximum = Math.max(maximum, active);
      await new Promise<void>(resolve => setImmediate(resolve));
      changed.add(String(path));
      active -= 1;
    };
    await preparePrimaryImagePaths(app, join(root, 'tmp/example'), { chown: own, lchown: own });
    assert.ok(maximum > 1 && maximum <= 32);
    assert.equal(active, 0);
    for (const path of files) assert.ok(changed.has(path));
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('missing dynamic dependencies fail the build rather than passing an incomplete runtime', () => {
  const loaded: string[] = [];
  verifyPrimaryDependencies(name => { loaded.push(name); });
  assert.deepEqual(loaded, ['playwright', 'sharp']);
  for (const absent of ['playwright', 'sharp']) {
    assert.throws(() => verifyPrimaryDependencies(name => {
      if (name === absent) throw new Error(`Missing ${name}`);
    }), new RegExp(`Missing ${absent}`));
  }
});

test('invalid external PORT never contacts a service', async () => {
  for (const port of [undefined, '', '0', '65536', '-1', '8080/evil', 'http://remote', ' 8080']) {
    assert.throws(() => primaryHealthUrl(port));
    let contacted = false;
    assert.equal(await primaryImageHealthy(port, async () => { contacted = true; return new Response(); }), false);
    assert.equal(contacted, false);
  }
  assert.equal(primaryHealthUrl('8080'), 'http://127.0.0.1:8080/health');
});

test('native health probe accepts success and rejects unhealthy, disconnected and stalled runtimes', async () => {
  let status = 200;
  let stalled = false;
  const paths: string[] = [];
  const server = createServer((request, response) => {
    paths.push(request.url ?? '');
    if (!stalled) { response.writeHead(status); response.end('health'); }
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  const port = String(address.port);
  try {
    assert.equal(await primaryImageHealthy(port), true);
    status = 503;
    assert.equal(await primaryImageHealthy(port), false);
    stalled = true;
    const started = Date.now();
    assert.equal(await primaryImageHealthy(port), false);
    assert.ok(Date.now() - started < 3_000, 'probe exceeded native Docker timeout');
    assert.deepEqual(paths, ['/health', '/health', '/health']);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  }
  assert.equal(await primaryImageHealthy(port), false);
});
