import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const enabledRead = /\b([A-Za-z_][A-Za-z0-9_]*)\.isEnabled\b/g;
const snapshotVariable = /(?:snapshot|snap)$/i;

export interface EnabledStateViolation {
  readonly file: string;
  readonly line: number;
  readonly source: string;
}

/**
 * Finds direct `XCUIElement.isEnabled` reads in shared page objects.
 * Snapshot values are permitted because they observe disappearance and state
 * atomically instead of dereferencing a stale accessibility handle.
 */
export async function findEnabledStateViolations(
  repositoryRoot: string,
): Promise<readonly EnabledStateViolation[]> {
  const pageObjectsDirectory = path.join(
    repositoryRoot,
    'ios',
    'example-iosUITests',
    'PageObjects',
  );
  const entries = await readdir(pageObjectsDirectory, { withFileTypes: true });
  const violations: EnabledStateViolation[] = [];

  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith('.swift')) continue;

    const filePath = path.join(pageObjectsDirectory, entry.name);
    const lines = (await readFile(filePath, 'utf8')).split('\n');
    for (const [index, line] of lines.entries()) {
      if (line.trim().startsWith('//')) continue;

      for (const match of line.matchAll(enabledRead)) {
        if (snapshotVariable.test(match[1] ?? '')) continue;
        violations.push({
          file: path.relative(repositoryRoot, filePath),
          line: index + 1,
          source: line.trim(),
        });
      }
    }
  }

  return violations;
}

export function formatEnabledStateViolations(
  violations: readonly EnabledStateViolation[],
): string {
  return 'Direct XCUIElement.isEnabled reads are forbidden in shared page objects.\n'
    + 'Use a throwable XCUIElement snapshot so disappearance is observed atomically:\n'
    + violations.map(({ file, line, source }) => `  ${file}:${line}:${source}`).join('\n');
}

export async function lintIosUiTestElementState(repositoryRoot: string): Promise<void> {
  const violations = await findEnabledStateViolations(repositoryRoot);
  if (violations.length > 0) throw new Error(formatEnabledStateViolations(violations));
  console.log('Shared iOS page objects read enabled state from throwable snapshots.');
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  await lintIosUiTestElementState(process.cwd()).catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
