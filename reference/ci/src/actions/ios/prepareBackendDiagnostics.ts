import { mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { z } from 'zod';

import { planDiagnosticCopies, redactDiagnosticLog } from '../../ios/backendDiagnosticRedaction.ts';
import { readStepEnvironment } from '../../ios/shared/stepEnvironment.ts';
import { runStep } from '../../ios/shared/stepIo.ts';

/**
 * Copies the lane's development-backend logs into the diagnostics directory
 * with their credentials removed.
 *
 * The diagnostics artifact is downloadable by anyone who can read the run, and
 * the dev server logs request headers, so nothing is copied verbatim. A log
 * the lane never produced is simply not copied, as the shell's `[ ! -f … ]`
 * guard decided.
 */

const environmentSchema = z.object({
  BACKEND_DIAGNOSTICS_DIR: z.string().min(1, 'BACKEND_DIAGNOSTICS_DIR is required'),
});

function isFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

await runStep('Backend diagnostics redaction', () => {
  const { BACKEND_DIAGNOSTICS_DIR: diagnosticsDirectory } = readStepEnvironment(environmentSchema);
  mkdirSync(diagnosticsDirectory, { recursive: true });

  for (const copy of planDiagnosticCopies(diagnosticsDirectory, process.env, isFile)) {
    // Read as bytes and decode with replacement, as the Python this replaces
    // did: a dev server that logged a raw byte must not fail the redaction.
    const content = readFileSync(copy.sourcePath).toString('utf8');
    writeFileSync(copy.destinationPath, redactDiagnosticLog(content), 'utf8');
  }
});
