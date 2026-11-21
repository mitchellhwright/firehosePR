import { chmod, chown, lchown, lstat, mkdir, readdir, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';

const runtimeIdentity = { uid: 10001, gid: 10001 } as const;
export interface ImagePermissionIo {
  readonly chown: typeof chown;
  readonly lchown: typeof lchown;
}

/** Preserve symlinks without chmod following them outside the immutable tree. */
async function visit(path: string, apply: (path: string, mode: number, symlink: boolean) => Promise<void>): Promise<void> {
  const pending = [path];
  // Bound filesystem pressure while avoiding one round trip per image file.
  while (pending.length !== 0) {
    const batch = pending.splice(-32);
    await Promise.all(batch.map(async entry => {
      const stat = await lstat(entry);
      await apply(entry, stat.mode, stat.isSymbolicLink());
      if (stat.isDirectory()) {
        for (const child of await readdir(entry)) pending.push(join(entry, child));
      }
    }));
  }
}

export async function preparePrimaryImagePaths(app: string, temporary: string, io: ImagePermissionIo = { chown, lchown }): Promise<void> {
  const cache = join(app, '.next/cache');
  const writable = [cache, temporary, join(temporary, 'cache'), join(temporary, 'config')];
  for (const path of writable) await mkdir(path, { recursive: true });
  for (const root of [cache, temporary]) {
    await visit(root, async (path, _mode, symlink) => {
      await (symlink ? io.lchown : io.chown)(path, runtimeIdentity.uid, runtimeIdentity.gid);
    });
  }
  await visit(app, async (path, mode, symlink) => {
    if (!symlink) await chmod(path, mode & ~0o022);
  });
  await chmod(app, 0o755);
  await chmod(resolve(temporary, '..'), 0o755);
  for (const path of writable) await chmod(path, 0o700);
}

export const runtimePackageManagers = [
  '/usr/local/lib/node_modules/npm', '/usr/local/bin/npm', '/usr/local/bin/npx',
  '/usr/local/bin/corepack', '/usr/local/bin/yarn',
] as const;

export function verifyPrimaryDependencies(load: (name: string) => unknown): void {
  for (const dependency of ['playwright', 'sharp']) load(dependency);
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  if (process.argv.length !== 3) throw new Error('Expected one primary image setup mode');
  switch (process.argv[2]) {
    case 'dependencies':
      verifyPrimaryDependencies(createRequire(import.meta.url));
      break;
    case 'permissions':
      await preparePrimaryImagePaths('/app', '/tmp/example');
      for (const path of runtimePackageManagers) await rm(path, { recursive: true, force: true });
      break;
    default: throw new Error('Unknown primary image setup mode');
  }
}
