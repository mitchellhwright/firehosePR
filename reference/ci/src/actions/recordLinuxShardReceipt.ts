import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import { captureLinuxShardSnapshot } from '../linuxShardReceiptCapture.ts';
import {
  completeLinuxShardReceipt, encodeLinuxShardReceiptLog, linuxShardContextSchema,
} from '../linuxShardReceipt.ts';
import { readStepEnvironment } from '../ios/shared/stepEnvironment.ts';
import { installSignalTraps } from '../ios/shared/processRunner.ts';
import { pass, runAsyncStepProgram } from '../ios/shared/stepDecision.ts';

installSignalTraps(() => {});
await runAsyncStepProgram('Linux server shard receipt', async () => {
  const env = readStepEnvironment(z.object({
    RECEIPT_PHASE: z.enum(['prepare', 'complete']), RECEIPT_DIRECTORY: z.string().min(1),
    PR_NUMBER: z.string(), PR_BASE_SHA: z.string(), PR_HEAD_SHA: z.string(), PR_HEAD_REPOSITORY: z.string(),
    GITHUB_REPOSITORY: z.string(), GITHUB_SHA: z.string(), GITHUB_RUN_ID: z.string(),
    GITHUB_RUN_ATTEMPT: z.string(), GITHUB_WORKFLOW_REF: z.string(), GITHUB_WORKFLOW_SHA: z.string().optional(), RECEIPT_WORKFLOW_SHA: z.string().optional(),
    GITHUB_JOB: z.string(), SHARD: z.string(), SHARD_OUTCOME: z.string().optional(),
  }));
  const snapshotPath = join(env.RECEIPT_DIRECTORY, 'inputs.json');
  if (env.RECEIPT_PHASE === 'prepare') {
    mkdirSync(env.RECEIPT_DIRECTORY, { recursive: true });
    rmSync(snapshotPath, { force: true });
  }
  const context = linuxShardContextSchema.parse({
    repository: env.GITHUB_REPOSITORY, headRepository: env.PR_HEAD_REPOSITORY,
    prNumber: Number(env.PR_NUMBER), baseSha: env.PR_BASE_SHA, headSha: env.PR_HEAD_SHA,
    expectedMergeSha: env.GITHUB_SHA, runId: Number(env.GITHUB_RUN_ID),
    runAttempt: Number(env.GITHUB_RUN_ATTEMPT), workflowRef: env.GITHUB_WORKFLOW_REF,
    workflowSha: env.RECEIPT_WORKFLOW_SHA || env.GITHUB_WORKFLOW_SHA || null, job: env.GITHUB_JOB, shard: Number(env.SHARD),
  });
  const snapshot = await captureLinuxShardSnapshot(context);
  if (env.RECEIPT_PHASE === 'prepare') {
    writeFileSync(snapshotPath, JSON.stringify(snapshot) + '\n', { flag: 'wx' });
  } else {
    const before: unknown = JSON.parse(readFileSync(snapshotPath, 'utf8'));
    const receipt = completeLinuxShardReceipt(before, snapshot, env.SHARD_OUTCOME ?? '');
    console.log(encodeLinuxShardReceiptLog(receipt));
    console.log(`Recorded shard ${context.shard}/4 for merge ${receipt.mergeSha}; reuse remains disabled.`);
  }
  return pass();
});
