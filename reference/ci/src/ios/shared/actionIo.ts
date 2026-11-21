import { appendFileSync } from 'node:fs';

/**
 * The GitHub Actions step boundary: reading `env`, writing `$GITHUB_OUTPUT`
 * and `$GITHUB_ENV`, and emitting workflow annotations.
 *
 * Shared by every typed iOS step so a program never re-implements `${VAR:?}`
 * or an `appendFileSync` to the wrong file. Placed under `ios/shared` because
 * the iOS workflow is being converted step by step; when the other steps land
 * this is the module they import rather than copy. It carries only what a
 * converted step uses today — a step that needs a `$GITHUB_OUTPUT` writer or a
 * `::warning::` adds it here, not beside itself.
 */

/** The shell's `${NAME:?}`: present and non-empty, or the step fails closed. */
export function requiredEnv(name: string, environment: NodeJS.ProcessEnv = process.env): string {
  const value = environment[name];
  if (value === undefined || value.length === 0) {
    throw new Error(`${name}: parameter null or not set`);
  }
  return value;
}

/** The shell's `${NAME:-default}`. */
export function optionalEnv(
  name: string,
  fallback = '',
  environment: NodeJS.ProcessEnv = process.env,
): string {
  const value = environment[name];
  return value === undefined || value.length === 0 ? fallback : value;
}

/** The shell's `[ "$NAME" = "true" ]`; every other value, including blank, is false. */
export function booleanEnv(name: string, environment: NodeJS.ProcessEnv = process.env): boolean {
  return environment[name] === 'true';
}

function appendToFile(variableName: string, line: string): void {
  const path = process.env[variableName];
  if (path === undefined || path.length === 0) {
    throw new Error(`${variableName} is required`);
  }
  appendFileSync(path, line, 'utf8');
}

/** Exports a whole block in one append, as the shell's `{ ... } >> $GITHUB_ENV` did. */
export function exportStepEnvBlock(entries: ReadonlyMap<string, string>): void {
  const lines = [...entries].map(([name, value]) => `${name}=${value}\n`).join('');
  if (lines.length > 0) appendToFile('GITHUB_ENV', lines);
}

/** The shell's `echo … >> "$GITHUB_STEP_SUMMARY"`; the newline is added here. */
export function appendStepSummary(line: string): void {
  appendToFile('GITHUB_STEP_SUMMARY', `${line}\n`);}

/**
 * Prepends a directory to `PATH` for every later step, as `echo … >>
 * "$GITHUB_PATH"` did. The current process keeps its own `PATH` unchanged, so
 * a step that also needs the directory itself uses the resolved binary.
 */
export function exportStepPath(directory: string): void {
  appendToFile('GITHUB_PATH', `${directory}\n`);}

/** Plain step-log output; annotations already carry their own `::` prefix. */
export function logLine(message: string): void {
  process.stdout.write(`${message}\n`);
}

export function annotateError(message: string): void {
  logLine(`::error::${message}`);
}

export function annotateNotice(message: string): void {
  logLine(`::notice::${message}`);
}

export function annotateWarning(message: string): void {
  logLine(`::warning::${message}`);
}
