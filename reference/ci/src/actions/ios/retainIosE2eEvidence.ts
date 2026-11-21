import { existsSync, statSync } from 'node:fs';
import { z } from 'zod';

import {
  evidenceRetentionKinds,
  isRetentionKindName,
  planEvidenceRetention,
} from '../../ios/e2eEvidenceRetention.ts';
import { runCommand } from '../../ios/shared/processRunner.ts';
import { renderStepMessage } from '../../ios/shared/stepDecision.ts';
import { readStepEnvironment } from '../../ios/shared/stepEnvironment.ts';
import { runStep } from '../../ios/shared/stepIo.ts';

/**
 * Keeps a real-server E2E lane's evidence on the runner and in the job
 * summary, through `scripts/persist-ios-ci-evidence.sh`.
 *
 * One program for the eight steps that did this: the fallback each lane runs
 * when its artifact upload fails, and the two debt-card evidence receipts that
 * are retained whether or not an upload happened. `IOS_EVIDENCE_RETENTION`
 * names which, and `ci/src/ios/e2eEvidenceRetention.ts` owns the list, the
 * label, and what an empty list means.
 */

const environmentSchema = z.object({
  IOS_EVIDENCE_RETENTION: z.string().min(1, 'IOS_EVIDENCE_RETENTION is required'),
});

function pathExists(path: string): boolean {
  return existsSync(path);
}

function isNonEmptyFile(path: string): boolean {
  try {
    const stats = statSync(path);
    return stats.isFile() && stats.size > 0;
  } catch {
    return false;
  }
}

await runStep('iOS E2E evidence retention', async () => {
  const { IOS_EVIDENCE_RETENTION: kindName } = readStepEnvironment(environmentSchema);
  if (!isRetentionKindName(kindName)) {
    throw new Error(`Unknown evidence retention kind: ${kindName}`);
  }

  const plan = planEvidenceRetention({
    kind: evidenceRetentionKinds[kindName],
    environment: process.env,
    pathExists,
    isNonEmptyFile,
  });
  for (const message of plan.messages) process.stdout.write(`${renderStepMessage(message)}\n`);
  if (plan.persist === undefined) {
    if (plan.exitCode !== 0) process.exitCode = plan.exitCode;
    return;
  }

  const result = await runCommand(
    'bash',
    ['scripts/persist-ios-ci-evidence.sh', plan.persist.label, ...plan.persist.paths],
  );
  if (result.status !== 0) process.exitCode = result.status;
});
