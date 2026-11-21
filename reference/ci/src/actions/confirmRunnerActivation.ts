import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

export type RunnerActivationState = 'success' | 'failure';

function activationRecord(value: unknown): Readonly<Record<string, unknown>> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Readonly<Record<string, unknown>>
    : undefined;
}

export function runnerActivationMarkerState(
  marker: string,
  context: string,
): RunnerActivationState {
  let parsed: unknown;
  try {
    parsed = JSON.parse(marker) as unknown;
  } catch {
    throw new Error('Runner activation marker is not valid JSON.');
  }
  const record = activationRecord(parsed);
  const valid = record !== undefined
    && Object.keys(record).length === 3
    && record['schema'] === 'example.runner-activation.v1'
    && (record['state'] === 'success' || record['state'] === 'failure')
    && typeof record['context'] === 'string';
  if (!valid || record === undefined) throw new Error('Runner activation marker is invalid.');
  if (record['context'] !== context) {
    throw new Error('Runner activation marker does not match the requested activation.');
  }
  return record['state'] as RunnerActivationState;
}

/** The detached activation's log on this host; `load` yields null when it is absent. */
export interface ActivationLog {
  readonly path: string;
  readonly load: () => Promise<string | null>;
}

const reportedLogLines = 40;

/**
 * Renders the log for a failure message. Each line is prefixed so no host
 * line can begin a workflow command when the message reaches the job log.
 */
async function describeActivationLog(log: ActivationLog | undefined): Promise<string> {
  if (log === undefined) return '';
  const contents = await log.load();
  if (contents === null) return `\nNo activation log at ${log.path}.`;
  const lines = contents.split('\n');
  if (lines.at(-1) === '') lines.pop();
  const shown = lines.slice(-reportedLogLines);
  const scope = shown.length < lines.length
    ? `showing the last ${shown.length} of ${lines.length} lines`
    : `${lines.length} lines`;
  return `\nActivation log ${log.path} (${scope}):\n${shown.map((line) => `  | ${line}`).join('\n')}`;
}

export async function confirmRunnerActivation(options: {
  readonly context?: string;
  readonly loadMarker?: () => Promise<string | null>;
  readonly activationLog?: ActivationLog;
}): Promise<'success'> {
  const { context, loadMarker, activationLog } = options;
  if (typeof context !== 'string' || !context.startsWith('runner-environment/')) {
    throw new Error('A stable runner activation context is required.');
  }
  if (loadMarker === undefined) {
    throw new Error('A local runner activation marker loader is required.');
  }
  const marker = await loadMarker();
  if (marker === null) {
    throw new Error(`Runner activation left no marker for ${context}; the detached process did not finish its cleanup.`
      + await describeActivationLog(activationLog));
  }
  if (runnerActivationMarkerState(marker, context) === 'failure') {
    throw new Error(`Runner activation reported failure for ${context}.`
      + await describeActivationLog(activationLog));
  }
  return 'success';
}

function requiredPath(name: string): string {
  const value = process.env[name];
  if (value === undefined || value.length === 0) throw new Error(`${name} is required.`);
  return value;
}

async function readIfPresent(path: string): Promise<string | null> {
  try {
    return await readFile(path, 'utf8');
  } catch (error: unknown) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return null;
    throw error;
  }
}

async function main(): Promise<void> {
  const context = process.env['ACTIVATION_CONTEXT'];
  const markerPath = requiredPath('ACTIVATION_MARKER_PATH');
  const logPath = requiredPath('ACTIVATION_LOG_PATH');
  await confirmRunnerActivation({
    context,
    loadMarker: () => readIfPresent(markerPath),
    activationLog: { path: logPath, load: () => readIfPresent(logPath) },
  });
  console.log(`Runner activation completed for ${context}.`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
