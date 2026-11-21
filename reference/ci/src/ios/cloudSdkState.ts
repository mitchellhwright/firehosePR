import { lstatSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { basename, dirname, isAbsolute, join } from 'node:path';

interface JobIdentity { readonly temporaryRoot: string; readonly canonicalRoot: string; readonly prefix: string }
function jobIdentity(environment: NodeJS.ProcessEnv): JobIdentity {
  const run = environment.GITHUB_RUN_ID ?? '';
  const attempt = environment.GITHUB_RUN_ATTEMPT ?? '';
  const job = environment.GITHUB_JOB ?? '';
  if (!/^[0-9]+$/.test(run) || !/^[0-9]+$/.test(attempt) || !/^[A-Za-z0-9_-]+$/.test(job)) {
    throw new Error('Refusing isolated Google Cloud SDK state without a valid workflow identity');
  }
  const input = environment.RUNNER_TEMP ?? '';
  const temporaryRoot = input.replace(/\/+$/, '');
  if (!isAbsolute(input) || !temporaryRoot || lstatSync(temporaryRoot).isSymbolicLink() || !lstatSync(temporaryRoot).isDirectory()) {
    throw new Error('Refusing isolated Google Cloud SDK state for unsafe RUNNER_TEMP');
  }
  const canonicalRoot = realpathSync(input);
  if (canonicalRoot === '/') throw new Error('Refusing isolated Google Cloud SDK state at filesystem root');
  return { temporaryRoot, canonicalRoot, prefix: `example-gcloud-${run}-${attempt}-${job}.` };
}
export function createIsolatedCloudSdkState(environment: NodeJS.ProcessEnv): string {
  const identity = jobIdentity(environment);
  return mkdtempSync(join(identity.temporaryRoot, identity.prefix));
}
function missing(error: unknown): boolean {
  return error !== null && typeof error === 'object' && 'code' in error && error.code === 'ENOENT';
}
export type CloudSdkCleanupDecision = 'unowned' | 'already-absent' | 'removed';
export function removeIsolatedCloudSdkState(environment: NodeJS.ProcessEnv): CloudSdkCleanupDecision {
  const owned = environment.EXAMPLE_ISOLATED_CLOUDSDK_CONFIG ?? '';
  if (!owned) return 'unowned';
  if (environment.CLOUDSDK_CONFIG !== owned) {
    throw new Error('Refusing to remove Google Cloud SDK state without an exact run-owned active config match');
  }
  const identity = jobIdentity(environment);
  const name = basename(owned);
  if (owned !== join(identity.temporaryRoot, name) || dirname(owned) !== identity.temporaryRoot || !name.startsWith(identity.prefix)
    || !/^[A-Za-z0-9]{6}$/.test(name.slice(identity.prefix.length))) {
    throw new Error('Refusing to remove unexpected run-owned gcloud config');
  }
  try {
    const state = lstatSync(owned);
    if (state.isSymbolicLink() || !state.isDirectory()) throw new Error('Refusing to remove non-directory or symlinked run-owned gcloud config');
  } catch (error) {
    if (missing(error)) return 'already-absent';
    throw error;
  }
  const canonical = realpathSync(owned);
  if (dirname(canonical) !== identity.canonicalRoot || basename(canonical) !== name) {
    throw new Error('Refusing to remove non-canonical run-owned gcloud config');
  }
  // Node recursive removal does not follow nested symlinks. Only this job's exact directory is removed.
  rmSync(owned, { recursive: true, force: false });
  return 'removed';
}
