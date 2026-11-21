import { appendFileSync } from 'node:fs';

/**
 * The workflow-command surface a typed step program needs: exporting to later
 * steps and emitting the annotations the shell used to `echo`.
 *
 * Every iOS step program shares this module rather than re-deriving the
 * `>> "$GITHUB_ENV"` conventions, so an annotation or a heredoc delimiter is
 * spelled once for the whole lane.
 */

/** A `${NAME:?}` read: an unset or empty value ends the step, as it did in shell. */
export function requiredEnv(name: string, source: NodeJS.ProcessEnv = process.env): string {
  const value = source[name];
  if (value === undefined || value.length === 0) {
    throw new Error(`${name} is required`);
  }
  return value;
}

/** Appends `key=value` lines to `$GITHUB_ENV`, as a grouped `{ … } >> "$GITHUB_ENV"` did. */
export function appendGithubEnv(
  entries: Readonly<Record<string, string>>,
  source: NodeJS.ProcessEnv = process.env,
): void {
  const path = requiredEnv('GITHUB_ENV', source);
  const text = Object.entries(entries)
    .map(([key, value]) => `${key}=${value}\n`)
    .join('');
  appendFileSync(path, text, 'utf8');
}

/**
 * Appends one `$GITHUB_ENV` entry in the delimiter form. Secrets and anything
 * that could contain a newline must use this: a bare `key=value` line would
 * let a newline in the value forge a second entry.
 */
export function appendGithubEnvBlock(
  name: string,
  value: string,
  source: NodeJS.ProcessEnv = process.env,
): void {
  const path = requiredEnv('GITHUB_ENV', source);
  const delimiter = `${name}_EOF`;
  appendFileSync(path, `${name}<<${delimiter}\n${value}\n${delimiter}\n`, 'utf8');
}

/** `::add-mask::` keeps a value out of the log for the rest of the job. */
export function maskSecret(value: string): void {
  process.stdout.write(`::add-mask::${value}\n`);
}

/** `::error::` raises the annotation the shell raised; it does not exit. */
export function errorAnnotation(message: string): void {
  process.stdout.write(`::error::${message}\n`);
}

/** `::warning::` keeps advisory cleanup failures visible without changing a product verdict. */
export function warningAnnotation(message: string): void {
  process.stdout.write(`::warning::${message}\n`);
}

export function log(message: string): void {
  process.stdout.write(`${message}\n`);
}

export function warn(message: string): void {
  process.stderr.write(`${message}\n`);
}
