import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { z } from 'zod';
import { partitionUiTestFiles } from './uiTestPartition.ts';

const laneSchema = z.enum(['native1', 'native2', 'native3', 'native4']);
export type NativeUiLane = z.infer<typeof laneSchema>;

const weightsSchema = z.object({ classes: z.record(z.string(), z.number().positive()) });

/** The checked-out candidate: the Actions workspace, or the working directory outside Actions. */
function candidateDataRoot(): string {
  const workspace = process.env['GITHUB_WORKSPACE'];
  return workspace !== undefined && workspace !== '' ? workspace : process.cwd();
}

const exactOwnerLanes = ['native2', 'native3', 'native4'] as const;

/**
 * Each exact method's lane in the three-way duration-balanced partition of
 * the CI test plan's `example-iosUITests` target, keyed by the identifier as the
 * selection wrote it. Identifiers the partition does not contain (bare
 * classes, unit tests, excluded methods) have no entry.
 */
function exactUiOwners(
  identifiers: readonly string[],
  dataRoot: string,
): Record<string, NativeUiLane> {
  const partition = partitionUiTestFiles({
    testPlanPath: resolve(dataRoot, 'ios/example-ios.xcodeproj/xcshareddata/TestPlans/CI.xctestplan'),
    sourceRoot: resolve(dataRoot, 'ios/example-iosUITests'),
    durationHintsPath: resolve(dataRoot, 'ios/ci/ui-test-duration-weights.json'),
    target: 'example-iosUITests',
    exclusionsPath: resolve(dataRoot, 'ios/ci/ui-test-primary-exclusions.txt'),
    shardCount: exactOwnerLanes.length,
  });
  const queries = new Map<string, string>();
  for (const identifier of identifiers) {
    const trimmed = identifier.trim();
    if (trimmed.length > 0) queries.set(trimmed.replace(/\(\)$/, ''), trimmed);
  }
  const owners: Record<string, NativeUiLane> = {};
  for (const [index, lane] of exactOwnerLanes.entries()) {
    for (const member of partition.shards[index] ?? []) {
      const original = queries.get(member.replace(/\(\)$/, ''));
      if (original !== undefined) owners[original] = lane;
    }
  }
  return owners;
}

const native1OnlyBareClasses = new Set([
  'example-iosUITests/TourCopyReviewEvidenceUITests',
]);

/**
 * Exact methods retain the existing full-suite owner. Bare affected classes
 * are balanced as atomic units between native1 and native2.
 *
 * The change gate computes this once: the planner keys its execution lanes on
 * it and publishes it as the gate output `native_ui_method_owners`, which each
 * Mac lane reads instead of recomputing, so a class cannot silently disappear
 * between planning and execution. The program runs from this module's
 * checkout, which on a queue candidate is the trusted queue base. The UI
 * tests, test plan and lane weights it partitions come from `dataRoot`, the
 * checked-out candidate (the job's workspace by default), so a class the
 * candidate adds still gets an owner.
 */
export function affectedUiOwners(
  identifiersFile: string,
  evidenceGroups: readonly string[],
  dataRoot: string = candidateDataRoot(),
): Record<string, NativeUiLane> {
  if (identifiersFile.length === 0) return {};
  const identifiers = readFileSync(identifiersFile, 'utf8').split('\n').filter(Boolean);
  const exactOwners = exactUiOwners(identifiers, dataRoot);
  const weights = weightsSchema.parse(JSON.parse(readFileSync(
    resolve(dataRoot, 'ios/ci/ui-test-duration-weights.json'), 'utf8',
  ))).classes;
  const classIdentifiers = identifiers.filter((identifier) => {
    const parts = identifier.split('/');
    if (parts.length !== 2 || !parts[0]?.endsWith('UITests')) return false;
    if (evidenceGroups.includes('account-update') &&
      /^(ActivationIntroManageAccounts|CardAccountUpdateReturn)/.test(parts[1] ?? '')) return false;
    return true;
  });
  const ordered = classIdentifiers.sort((left, right) => {
    const leftWeight = weights[left.split('/')[1] ?? ''] ?? 30;
    const rightWeight = weights[right.split('/')[1] ?? ''] ?? 30;
    return rightWeight - leftWeight || (left < right ? -1 : left > right ? 1 : 0);
  });
  const loads = { native1: 0, native2: 0 };
  for (const identifier of ordered) {
    // The TourCopy class includes fixture-owned financial-independence evidence
    // that the execution script dispatches only from native1.
    const owner = native1OnlyBareClasses.has(identifier) || loads.native1 <= loads.native2
      ? 'native1' : 'native2';
    exactOwners[identifier] = owner;
    loads[owner] += weights[identifier.split('/')[1] ?? ''] ?? 30;
  }
  return exactOwners;
}
