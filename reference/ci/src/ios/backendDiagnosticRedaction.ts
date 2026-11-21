/**
 * Redacting the development backend logs a real-server E2E lane uploads.
 *
 * The lane's dev server prints request headers and its own bearer tokens, and
 * the diagnostics artifact is downloadable by anyone who can read the run, so
 * the copies that go into it have their credentials removed first. The two
 * patterns are the ones the step's inlined Python carried; they live here as a
 * pure function so each shape has a test that proves it still redacts.
 */

/**
 * `authorization: abc`, `token="abc"`, `Password = abc` — the key, whatever
 * separator and quoting follows it, then a run of characters that is not a
 * quote, whitespace, comma or closing brace. Only the value is replaced, so
 * the surrounding JSON or log line still parses.
 */
const labelledSecret = /\b(authorization|cookie|token|secret|password)\b(\s*["']?\s*[:=]\s*["']?)([^"'\s,}]+)/gi;

/** A bearer token that carries no key, as an `Authorization` header value. */
const bearerToken = /\bBearer\s+[A-Za-z0-9._~+/=-]+/gi;

export function redactDiagnosticLog(content: string): string {
  return content
    .replace(labelledSecret, (_match, key: string, separator: string) => `${key}${separator}[REDACTED]`)
    .replace(bearerToken, 'Bearer [REDACTED]');
}

export interface DiagnosticCopy {
  readonly sourceVariable: string;
  readonly destinationName: string;
}

/**
 * The two logs copied into the diagnostics directory, and what each is called
 * there. Both are optional: a lane that never started its backend has neither,
 * and the shell returned from `redact_log` without copying rather than failing.
 */
export const diagnosticCopies: readonly DiagnosticCopy[] = [
  { sourceVariable: 'ONBOARDING_DEV_BACKEND_LOG', destinationName: 'devserver.log' },
  { sourceVariable: 'ONBOARDING_DEV_BACKEND_SUPERVISOR_LOG', destinationName: 'devserver-supervisor.log' },
];

export interface PlannedDiagnosticCopy {
  readonly sourcePath: string;
  readonly destinationPath: string;
}

/**
 * Which copies to make. A source variable that is unset or empty contributes
 * nothing, matching `redact_log "${VAR:-}" …` landing on `[ ! -f "" ]`.
 */
export function planDiagnosticCopies(
  diagnosticsDirectory: string,
  values: Readonly<Record<string, string | undefined>>,
  fileExists: (path: string) => boolean,
): readonly PlannedDiagnosticCopy[] {
  const planned: PlannedDiagnosticCopy[] = [];
  for (const copy of diagnosticCopies) {
    const sourcePath = values[copy.sourceVariable] ?? '';
    if (sourcePath.length === 0 || !fileExists(sourcePath)) continue;
    planned.push({ sourcePath, destinationPath: `${diagnosticsDirectory}/${copy.destinationName}` });
  }
  return planned;
}
