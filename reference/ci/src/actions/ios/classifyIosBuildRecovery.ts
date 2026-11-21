import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { classifyIosRecovery } from '../../ios/iosBuildRecovery.ts';

/**
 * Prints the recovery a failed iOS command's log qualifies for, or nothing
 * when the failure must stand. `scripts/run-with-ios-cache-recovery.sh` calls
 * this once, after the first attempt fails.
 *
 * Usage: classifyIosBuildRecovery.ts <log-path>
 */
export function classifyIosBuildRecovery(argv: readonly string[]): string {
  const [logPath] = argv;
  if (argv.length !== 1 || logPath === undefined || logPath.length === 0) {
    throw new Error('usage: classifyIosBuildRecovery.ts <log-path>');
  }
  return classifyIosRecovery(readFileSync(logPath, 'utf8')) ?? '';
}

if (process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1]) {
  try {
    const kind = classifyIosBuildRecovery(process.argv.slice(2));
    if (kind.length > 0) process.stdout.write(`${kind}\n`);
  } catch (cause) {
    console.error(`::error::Could not classify the failed iOS command: ${
      cause instanceof Error ? cause.message : String(cause)}`);
    process.exitCode = 2;
  }
}
