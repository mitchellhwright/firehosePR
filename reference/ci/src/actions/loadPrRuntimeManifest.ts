import { readFileSync, writeFileSync } from 'node:fs';
import { z } from 'zod';
import { loadRuntimeManifest, runtimeManifestPath, type RuntimeManifestResult } from '../prRuntimeManifest.ts';
import { readStepEnvironment } from '../ios/shared/stepEnvironment.ts';
import { installSignalTraps } from '../ios/shared/processRunner.ts';

const env = readStepEnvironment(z.object({
  METADATA_ONLY: z.enum(['true', 'false', '']).default(''),
  CHANGED_FILES_FILE: z.string().min(1), DELETED_FILES_FILE: z.string().min(1),
  BASE_REPOSITORY: z.string().default(''), HEAD_SHA: z.string().default(''),
  PR_NUMBER: z.string().default(''), MERGE_GROUP_REF: z.string().default(''),
  GITHUB_TOKEN: z.string().default(''),
  GITHUB_FALLBACK_TOKEN: z.string().default(''),
  RUNTIME_CONTRACT_PATH: z.literal(runtimeManifestPath),
  RUNTIME_CONTRACT_OUTPUT: z.string().min(1),
}));
const files = (path: string): string[] => readFileSync(path, 'utf8').split(/\r?\n/).filter(Boolean);
const cancellation = new AbortController();
process.once('SIGINT', () => cancellation.abort());
process.once('SIGTERM', () => cancellation.abort());
let operation: Promise<RuntimeManifestResult> | undefined;
installSignalTraps(async () => {
  // Child termination unblocks the reader, whose finally removes its ref.
  // Wait for that whole operation rather than exiting while cleanup is running.
  try { await operation; } catch { /* The cancellation status is set by the signal handler. */ }
});
operation = loadRuntimeManifest({
  metadataOnly: env.METADATA_ONLY === 'true',
  revision: {
    repository: env.BASE_REPOSITORY, headSha: env.HEAD_SHA, prNumber: env.PR_NUMBER,
    queueRef: env.MERGE_GROUP_REF,
    tokens: [...new Set([env.GITHUB_TOKEN, env.GITHUB_FALLBACK_TOKEN].filter(Boolean))],
  },
  changedFiles: env.METADATA_ONLY === 'true' ? [] : files(env.CHANGED_FILES_FILE),
  deletedFiles: env.METADATA_ONLY === 'true' ? [] : files(env.DELETED_FILES_FILE),
}, undefined, cancellation.signal);
try {
  const result = await operation;
  cancellation.signal.throwIfAborted();
  writeFileSync(env.RUNTIME_CONTRACT_OUTPUT, result.contents);
  console.log(`Runtime contract source: ${result.source}`);
} catch (error: unknown) {
  if (!cancellation.signal.aborted) throw error;
}
