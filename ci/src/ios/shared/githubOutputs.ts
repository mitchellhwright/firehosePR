import { appendFileSync } from 'node:fs';

/**
 * Writing `$GITHUB_OUTPUT` and `$GITHUB_ENV` from a typed step program.
 *
 * Every converted iOS step needs the same two things: render `key=value`
 * lines exactly as the shell did, and append them to the file GitHub named.
 * The rendering half is pure so a test can assert on the text a step would
 * write without touching a filesystem; the appending half is the only part
 * that performs I/O.
 *
 * Kept under `ci/src/ios/shared/` because several converted steps write
 * outputs and there must be exactly one implementation of the multi-line
 * delimiter form, which is the part that is easy to get subtly wrong.
 */

export type StepOutputEntry = readonly [name: string, value: string];

/**
 * The single-line form. GitHub splits on the first `=`, so a value that
 * contains a newline would be read as further keys; `renderMultilineOutput`
 * is the form for those.
 */
export function renderStepOutputs(entries: readonly StepOutputEntry[]): string {
  let rendered = '';
  for (const [name, value] of entries) {
    if (value.includes('\n')) {
      throw new Error(`Step output ${name} contains a newline; use the multi-line delimiter form`);
    }
    rendered += `${name}=${value}\n`;
  }
  return rendered;
}

/**
 * The heredoc form: `name<<DELIMITER`, the value, then the delimiter alone on
 * its own line. A value carrying the delimiter as a whole line would end the
 * block early and leak the rest into the file as further keys, so that is
 * rejected rather than written.
 */
export function renderMultilineOutput(name: string, value: string, delimiter: string): string {
  if (value.split('\n').includes(delimiter)) {
    throw new Error(`Step output ${name} contains its own ${delimiter} delimiter on a line`);
  }
  return `${name}<<${delimiter}\n${value}\n${delimiter}\n`;
}

function appendTo(variable: string, contents: string): void {
  const path = process.env[variable];
  if (path === undefined || path.length === 0) throw new Error(`${variable} is required`);
  appendFileSync(path, contents, 'utf8');
}

export function appendStepOutputs(entries: readonly StepOutputEntry[]): void {
  appendTo('GITHUB_OUTPUT', renderStepOutputs(entries));
}

export function appendMultilineStepOutput(name: string, value: string, delimiter: string): void {
  appendTo('GITHUB_OUTPUT', renderMultilineOutput(name, value, delimiter));
}

export function appendJobEnvironment(entries: readonly StepOutputEntry[]): void {
  appendTo('GITHUB_ENV', renderStepOutputs(entries));
}
