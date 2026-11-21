import { existsSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';

import { annotateError, logLine, requiredEnv } from '../../ios/shared/actionIo.ts';
import { runCommand } from '../../ios/shared/processRunner.ts';
import { laneRunDirectoryPrefix, retainedEvidence } from '../../ios/executionPlan.ts';
import type { RetainedEvidenceKind } from '../../ios/executionPlan.ts';

/**
 * `Retain iOS Test screenshot evidence in job summary` and `Retain iOS Test
 * diagnostics on runner`.
 *
 * Both run only after their artifact upload failed, and both do the same
 * thing: find what the lane actually produced under `$RUNNER_TEMP` and persist
 * it where a reviewer can still reach it. An upload failure with nothing to
 * persist is itself a failure — evidence that exists nowhere is the one case
 * these steps must not report as handled.
 *
 * `retainedEvidence` owns the inventory, so the diagnostics this retains stay
 * the same set the upload step lists.
 */

const persist = resolve(process.cwd(), '..', 'scripts/persist-ios-ci-evidence.sh');

const retentions: readonly RetainedEvidenceKind[] = ['screenshots', 'diagnostics'];

function requestedRetention(): RetainedEvidenceKind {
  const requested = requiredEnv('IOS_RETAINED_EVIDENCE');
  const retention = retentions.find((candidate) => candidate === requested);
  if (retention === undefined) throw new Error(`Unknown iOS evidence retention: ${requested}`);
  return retention;
}

/** The lane's own result directories, in the order the step's glob yielded them. */
function laneRunDirectories(runnerTemp: string, prefix: string): readonly string[] {
  return readdirSync(runnerTemp)
    .filter((name) => name.startsWith(prefix))
    .sort()
    .map((name) => join(runnerTemp, name));
}

/**
 * Entries at any depth whose name ends with `suffix`, which is what the step's
 * `globstar` `**` matched. A match is not descended into: an `.xcresult` is
 * retained whole rather than as the files inside it.
 */
function descendantsEndingWith(directory: string, suffix: string): readonly string[] {
  const found: string[] = [];
  for (const entry of readdirSync(directory, { withFileTypes: true }).sort(
    (left, right) => left.name.localeCompare(right.name),
  )) {
    const path = join(directory, entry.name);
    if (entry.name.endsWith(suffix)) {
      found.push(path);
    } else if (entry.isDirectory()) {
      found.push(...descendantsEndingWith(path, suffix));
    }
  }
  return found;
}

function matches(runDirectory: string, pattern: string): readonly string[] {
  if (!pattern.startsWith('**/*')) {
    const path = join(runDirectory, pattern);
    return existsSync(path) ? [path] : [];
  }
  return descendantsEndingWith(runDirectory, pattern.slice('**/*'.length));
}

async function run(): Promise<number> {
  const evidence = retainedEvidence(requestedRetention(), requiredEnv('EXECUTION_LANE'));
  const runDirectories = laneRunDirectories(
    requiredEnv('RUNNER_TEMP'),
    laneRunDirectoryPrefix(requiredEnv('GITHUB_RUN_ID'), requiredEnv('GITHUB_RUN_ATTEMPT')),
  );
  const paths = evidence.patterns.flatMap(
    (pattern) => runDirectories.flatMap((runDirectory) => matches(runDirectory, pattern)),
  );
  if (paths.length === 0) {
    logLine(evidence.emptyMessage);
    return 1;
  }
  const persisted = await runCommand('bash', [persist, evidence.label, ...paths], {
    cwd: process.cwd(),
  });
  return persisted.status;
}

run().then((status) => {
  process.exitCode = status;
}).catch((error: unknown) => {
  annotateError(
    `iOS evidence retention failed: ${error instanceof Error ? error.message : String(error)}`,
  );
  process.exitCode = 1;
});
