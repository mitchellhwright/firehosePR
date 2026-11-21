import { createHash } from 'node:crypto';
import { z } from 'zod';
import { linuxServerShardCommand } from './linuxServerShard.ts';

const sha = z.string().regex(/^[a-f0-9]{40}$/);
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const positiveId = z.number().int().positive().safe();
const repository = z.string().regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/);
export const linuxShardReceiptInputPaths = [
  'package.json', 'package-lock.json', 'server/vitest.config.ts',
  'ci/src/actions/installNodeDependencies.ts', 'ci/src/nodeModulesCache.ts',
  '.github/workflows/pr-checks.yml',
  'ci/src/linuxServerShard.ts', 'ci/src/linuxShardReceipt.ts',
  'ci/src/linuxShardReceiptCapture.ts', 'ci/src/actions/recordLinuxShardReceipt.ts',
  'ci/src/changedCodeCoverage.ts', 'ci/src/actions/runLinuxCoverageShard.ts',
] as const;

export const linuxShardContextSchema = z.object({
  repository,
  headRepository: repository,
  prNumber: positiveId,
  baseSha: sha,
  headSha: sha,
  expectedMergeSha: sha,
  runId: positiveId,
  runAttempt: positiveId,
  workflowRef: z.string().min(1),
  workflowSha: sha.nullable(),
  job: z.literal('server-tests'),
  shard: z.union([z.literal(1), z.literal(2), z.literal(3), z.literal(4)]),
}).strict();
export type LinuxShardContext = z.infer<typeof linuxShardContextSchema>;

export const linuxShardRuntimeSchema = z.object({
  node: z.string().min(1), npm: z.string().min(1), vitest: z.string().min(1),
  platform: z.literal('linux'), arch: z.string().min(1), kernel: z.string().min(1),
  runnerOs: z.literal('Linux'), runnerArch: z.string().min(1),
  runnerEnvironment: z.enum(['github-hosted', 'self-hosted', 'unknown']),
  imageOs: z.string(), imageVersion: z.string(),
  ci: z.literal('true'), nodeEnv: z.string(), timezone: z.string(), nodeOptions: z.string(),
  // An explicitly selected dotenv file is outside this source-only receipt contract.
  envFile: z.literal(''),
}).strict();

const snapshotSchema = z.object({
  schema: z.literal('example.linux-server-shard-inputs.v1'),
  context: linuxShardContextSchema,
  mergeSha: sha,
  treeSha: sha,
  command: z.string().min(1),
  shardCount: z.literal(4),
  files: z.array(z.object({ path: z.string(), sha256: digest }).strict()),
  runtime: linuxShardRuntimeSchema,
  executionDigest: digest,
}).strict();
export type LinuxShardSnapshot = z.infer<typeof snapshotSchema>;

export const linuxShardReceiptSchema = snapshotSchema.extend({
  schema: z.literal('example.linux-server-shard-receipt.v1'),
  outcome: z.literal('success'),
}).strict();
export type LinuxShardReceipt = z.infer<typeof linuxShardReceiptSchema>;

/** Actions artifacts can be unavailable at the repository storage quota. This
 * marker keeps the non-gating observation in the successful job's own log.
 * A future reuse decision must also verify the GitHub job and Git objects. */
export const linuxShardReceiptLogPrefix = 'EXAMPLE_LINUX_SHARD_RECEIPT_V1=';

export function encodeLinuxShardReceiptLog(receipt: LinuxShardReceipt): string {
  const validated = linuxShardReceiptSchema.parse(receipt);
  return linuxShardReceiptLogPrefix + Buffer.from(JSON.stringify(validated)).toString('base64url');
}

export function parseLinuxShardReceiptLog(log: string): LinuxShardReceipt {
  const markers = log.split(/\r?\n/)
    .map(line => line.slice(line.indexOf(linuxShardReceiptLogPrefix)))
    .filter(line => line.startsWith(linuxShardReceiptLogPrefix));
  if (markers.length !== 1) {
    throw new Error(`Expected exactly one Linux shard receipt log marker, found ${markers.length}.`);
  }
  const encoded = markers[0]!.slice(linuxShardReceiptLogPrefix.length).trim();
  if (!/^[A-Za-z0-9_-]+$/.test(encoded)) throw new Error('Invalid Linux shard receipt log encoding.');
  const parsed: unknown = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8'));
  return linuxShardReceiptSchema.parse(parsed);
}

export function sha256(contents: string | Uint8Array): string {
  return createHash('sha256').update(contents).digest('hex');
}

export function createLinuxShardSnapshot(input: {
  readonly context: unknown;
  readonly mergeSha: string;
  readonly treeSha: string;
  readonly parents: readonly string[];
  readonly files: ReadonlyMap<string, string>;
  readonly runtime: unknown;
}): LinuxShardSnapshot {
  const context = linuxShardContextSchema.parse(input.context);
  if (input.mergeSha !== context.expectedMergeSha || input.parents.length !== 2
    || input.parents[0] !== context.baseSha || input.parents[1] !== context.headSha) {
    throw new Error('Checked-out merge commit does not match the event PR tuple.');
  }
  const payload = {
    schema: 'example.linux-server-shard-inputs.v1' as const,
    context,
    mergeSha: sha.parse(input.mergeSha), treeSha: sha.parse(input.treeSha),
    command: linuxServerShardCommand(context.shard), shardCount: 4 as const,
    files: linuxShardReceiptInputPaths.map(path => {
      const contents = input.files.get(path);
      if (contents === undefined) throw new Error(`Missing shard execution input: ${path}`);
      return { path, sha256: sha256(contents) };
    }),
    runtime: linuxShardRuntimeSchema.parse(input.runtime),
  };
  const { treeSha, command, shardCount, files, runtime } = payload;
  const executionDigest = sha256(JSON.stringify({ treeSha, command, shardCount, files, runtime }));
  return snapshotSchema.parse({ ...payload, executionDigest });
}

/** Observational only: later consumers must independently verify GitHub jobs and Git objects. */
export function completeLinuxShardReceipt(
  before: unknown,
  after: LinuxShardSnapshot,
  outcome: string,
): LinuxShardReceipt {
  const initial = snapshotSchema.parse(before);
  if (outcome !== 'success') throw new Error('A failed or skipped shard cannot produce a success receipt.');
  if (JSON.stringify(initial) !== JSON.stringify(after)) throw new Error('Shard execution inputs changed during the test.');
  return linuxShardReceiptSchema.parse({ ...after, schema: 'example.linux-server-shard-receipt.v1', outcome });
}
