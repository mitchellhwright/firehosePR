import { appendFileSync } from 'node:fs';

import { StepFailure } from './stepFailure.ts';

/**
 * The runner-facing edge of an iOS workflow step written as a TypeScript
 * program: reading the step's `env:`, writing `$GITHUB_OUTPUT`, and failing the
 * way the shell it replaced failed — one annotation on the stream the shell
 * used, then a non-zero exit.
 *
 * Shared by every program under `ci/src/actions/ios/`; nothing here knows
 * anything about iOS.
 */

export interface StepOutput {
  readonly key: string;
  readonly value: string;
  /**
   * Set for a value that may span lines. GitHub then reads the value from the
   * lines between two delimiter lines rather than from the first `=`, which is
   * how the shell wrote the changed-file inventories and the summary.
   */
  readonly delimiter?: string;
}

/** The value of `name`, or the empty string — what `${NAME:-}` reads in shell. */
export function optionalEnv(name: string): string {
  return process.env[name] ?? '';
}

/** The value of `name`, failing the step when it is unset or empty, like `${NAME:?}`. */
export function requiredEnv(name: string): string {
  const value = process.env[name];
  if (value === undefined || value === '') {
    throw new StepFailure(`${name}: parameter null or not set`, 'stderr');
  }
  return value;
}

export function formatStepOutputs(outputs: readonly StepOutput[]): string {
  let text = '';
  for (const output of outputs) {
    text += output.delimiter === undefined
      ? `${output.key}=${output.value}\n`
      : `${output.key}<<${output.delimiter}\n${output.value}\n${output.delimiter}\n`;
  }
  return text;
}

export function appendStepOutputs(outputs: readonly StepOutput[], outputPath?: string): void {
  appendFileSync(outputPath ?? requiredEnv('GITHUB_OUTPUT'), formatStepOutputs(outputs), 'utf8');
}

export function writeAnnotation(message: string, stream: 'stdout' | 'stderr' = 'stdout'): void {
  const target = stream === 'stderr' ? process.stderr : process.stdout;
  target.write(`${message}\n`);
}

/**
 * Runs a step program. A `StepFailure` reproduces the shell's own annotation
 * and exit status; anything else is a defect in the program, reported as one.
 */
export async function runStep(label: string, main: () => Promise<void> | void): Promise<void> {
  try {
    await main();
  } catch (error: unknown) {
    if (error instanceof StepFailure) {
      if (error.message.length > 0) writeAnnotation(error.message, error.stream);
      process.exitCode = error.exitCode;
      return;
    }
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`${label} failed: ${message}\n`);
    process.exitCode = 1;
  }
}
