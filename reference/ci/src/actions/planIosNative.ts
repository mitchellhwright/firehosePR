import { appendFileSync, readFileSync } from 'node:fs';
import { validationDepth } from '../ciEvent.ts';
import { affectedUiOwners } from '../ios/affectedUiOwners.ts';

import {
  deriveNativeExecutionPlan,
  iosLaneSchema,
  selectionModeSchema,
} from '../nativeExecutionPlan.ts';
import type { IosLane } from '../nativeExecutionPlan.ts';

function input(name: string, required = false): string {
  const value = process.env[`INPUT_${name.replaceAll(' ', '_').toUpperCase()}`] ?? '';
  if (required && value.length === 0) {
    throw new Error(`Missing required action input: ${name}`);
  }
  return value;
}

function readIdentifiers(filename: string): string[] {
  if (filename.length === 0) {
    return [];
  }
  return readFileSync(filename, 'utf8')
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

function readUiMethodOwners(filename: string, evidenceGroups: readonly string[]): Record<string, 'native1' | 'native2' | 'native3' | 'native4'> {
  if (filename.length === 0) {
    return {};
  }
  return affectedUiOwners(filename, evidenceGroups);
}

function parseForcedLanes(value: string): IosLane[] {
  const parsed: unknown = JSON.parse(value.length > 0 ? value : '[]');
  return iosLaneSchema.array().parse(parsed);
}

function parseBooleanInput(value: string): boolean {
  if (value === '' || value === 'false') {
    return false;
  }
  if (value === 'true') {
    return true;
  }
  throw new Error(`Expected true or false, received: ${value}`);
}

function writeOutput(name: string, value: string): void {
  const outputFile = process.env.GITHUB_OUTPUT;
  if (!outputFile) {
    throw new Error('GITHUB_OUTPUT is required');
  }
  appendFileSync(outputFile, `${name}=${value}\n`, 'utf8');
}

try {
  const onlyTestingFile = input('only-testing-file');
  const evidenceGroups = input('evidence-groups')
    .split(',')
    .map((group) => group.trim())
    .filter((group) => group.length > 0);
  // Computed once here: the Mac lanes read this output and never recompute it.
  const uiMethodOwners = readUiMethodOwners(onlyTestingFile, evidenceGroups);
  const plan = deriveNativeExecutionPlan({
    selectionMode: selectionModeSchema.parse(input('selection-mode', true)),
    selectionRequired: parseBooleanInput(input('selection-required')),
    releaseArchiveRequired: parseBooleanInput(input('release-archive-required')),
    onlyTestingIdentifiers: readIdentifiers(onlyTestingFile),
    evidenceGroups,
    narrowPaywallRequired: parseBooleanInput(input('narrow-paywall-required')),
    forcedLanes: parseForcedLanes(input('forced-lanes')),
    uiMethodOwners,
    // Set by the change gate; a missing value plans the complete suite.
    validationDepth: validationDepth(
      process.env['IOS_NATIVE_EVENT_NAME'] ?? '',
      process.env['IOS_NATIVE_BASE_BRANCH'] ?? '',
    ),
  });

  writeOutput('ui_required', String(plan.uiRequired));
  writeOutput('execution_required', String(plan.executionRequired));
  writeOutput('execution_lanes', JSON.stringify(plan.executionLanes));
  writeOutput('full_execution_lanes', JSON.stringify(plan.fullExecutionLanes));
  writeOutput('producer_mode', plan.producerMode);
  writeOutput('release_archive_required', String(plan.releaseArchiveRequired));
  writeOutput('handoff_required', String(plan.handoffRequired));
  writeOutput('ui_method_owners', JSON.stringify(uiMethodOwners));
  writeOutput('plan_json', JSON.stringify(plan));
} catch (error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`Typed iOS CI planning failed: ${message}\n`);
  process.exitCode = 1;
}
