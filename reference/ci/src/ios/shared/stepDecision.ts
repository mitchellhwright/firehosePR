/**
 * The shape every converted iOS status step produces, and the one place that
 * turns it into console output and an exit code.
 *
 * The shell these steps replace only ever did two things: print lines and
 * exit 0 or 1. Modelling that as a value keeps the decision pure — a test
 * asserts on the lines and the code without spawning anything — and keeps the
 * single side effect (write, then set the exit code) in one reviewed place.
 *
 * `error`, `notice` and `warning` render as `::error::`, `::notice::` and
 * `::warning::` workflow
 * annotations on stdout, which is where the replaced `echo "::error::…"` and
 * `echo "::notice::…"` wrote them. GitHub reads annotations from both streams,
 * but the tests that scrape these jobs read stdout.
 */

export type StepMessageLevel = 'info' | 'notice' | 'warning' | 'error';
export interface StepMessage {
  readonly level: StepMessageLevel;
  readonly text: string;
}

export interface StepDecision {
  readonly messages: readonly StepMessage[];
  /** 0 keeps the job green; 1 fails it, exactly as `exit 1` did. */
  readonly exitCode: 0 | 1;
}

export function info(text: string): StepMessage {
  return { level: 'info', text };
}

export function notice(text: string): StepMessage {
  return { level: 'notice', text };}

export function warning(text: string): StepMessage {
  return { level: 'warning', text };}

export function error(text: string): StepMessage {
  return { level: 'error', text };
}

/**
 * A lane the plan did not select, in the machine-readable form every aggregate
 * uses: `not selected: <why>` (the `not-selected` lane reason code).
 */
export function notSelected(why: string): StepMessage {
  return info(`not selected: ${why}`);
}

export function pass(...messages: readonly StepMessage[]): StepDecision {
  return { messages, exitCode: 0 };
}

export function fail(...messages: readonly StepMessage[]): StepDecision {
  return { messages, exitCode: 1 };
}

const annotationPrefixes: Readonly<Record<StepMessageLevel, string>> = {
  info: '',
  notice: '::notice::',
  warning: '::warning::',
  error: '::error::',
};

export function renderStepMessage(message: StepMessage): string {
  return `${annotationPrefixes[message.level]}${message.text}`;}

/** Every `::error::` line a decision carries, without the annotation prefix. */
export function decisionErrors(decision: StepDecision): readonly string[] {
  return decision.messages.filter((message) => message.level === 'error').map((m) => m.text);
}

export type LineWriter = (line: string) => void;

const writeStdout: LineWriter = (line) => {
  process.stdout.write(`${line}\n`);
};

/**
 * Prints the decision and adopts its exit code. `process.exitCode` rather than
 * `process.exit` so buffered stdout is flushed before the process ends.
 */
export function reportStepDecision(decision: StepDecision, write: LineWriter = writeStdout): void {
  writeStepMessages(decision.messages, write);
  if (decision.exitCode !== 0) process.exitCode = decision.exitCode;
}

/**
 * Prints messages where they fall, for a step that has to speak before it
 * acts — a plan that announces which trusted program it located, then runs it.
 */
export function writeStepMessages(
  messages: readonly StepMessage[],
  write: LineWriter = writeStdout,
): void {
  for (const message of messages) write(renderStepMessage(message));
}

/**
 * Runs a converted step's body, reporting its decision. A thrown error (a
 * boundary validation failure, say) fails the step the way `set -e` did.
 */
export function runStepProgram(label: string, body: () => StepDecision): void {
  try {
    reportStepDecision(body());
  } catch (cause: unknown) {
    reportProgramFailure(label, cause);
  }
}

/**
 * The same contract for a step whose body performs I/O — a process spawn, a
 * GitHub read — and therefore has to await. Kept beside the synchronous form
 * so both spellings report a thrown error identically.
 */
export async function runAsyncStepProgram(
  label: string,
  body: () => Promise<StepDecision>,
): Promise<void> {
  try {
    reportStepDecision(await body());
  } catch (cause: unknown) {
    reportProgramFailure(label, cause);
  }
}

function reportProgramFailure(label: string, cause: unknown): void {
  const message = cause instanceof Error ? cause.message : String(cause);
  process.stderr.write(`${label} failed: ${message}\n`);
  process.exitCode = 1;
}
