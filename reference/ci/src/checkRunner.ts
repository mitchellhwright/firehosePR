/**
 * `ci:check` runs every typed-layer check declared in package.json instead
 * of a hand-maintained `a && b && c` line. Each check is its own script, so
 * adding one is an insertion anywhere in `scripts`, never an edit of a line
 * every other change also edits — the last `package.json` conflict generator
 * in the stack.
 *
 * Contract: a check is a script named `ci:<name>` or `ci:<name>:check`. When
 * both exist (`ci:coverage` prints the report, `ci:coverage:check` enforces
 * the ratchet) only the `:check` form runs. `ci:deps` always runs first so
 * the layer's own dependencies exist; `ci:check` itself is excluded. This
 * module has no dependencies on purpose: it runs before `ci:deps` has.
 */

function packageScripts(packageJson: unknown): Record<string, string> {
  if (packageJson === null || typeof packageJson !== 'object' || !('scripts' in packageJson)) {
    throw new Error('package.json has no scripts block');
  }
  const scripts = (packageJson as { scripts: unknown }).scripts;
  if (scripts === null || typeof scripts !== 'object') throw new Error('package.json scripts must be an object');
  const entries = Object.entries(scripts as Record<string, unknown>);
  for (const [name, command] of entries) {
    if (typeof command !== 'string') throw new Error(`package.json script ${name} must be a string`);
  }
  return Object.fromEntries(entries as [string, string][]);
}

export function selectChecks(packageJson: unknown): string[] {
  const scripts = packageScripts(packageJson);
  const names = Object.keys(scripts).filter((name) => name.startsWith('ci:') && name !== 'ci:check' && name !== 'ci:deps');
  const enforced = new Set(names.filter((name) => name.endsWith(':check')).map((name) => name.slice(0, -':check'.length)));
  const checks = names.filter((name) => !enforced.has(name)).sort();
  return 'ci:deps' in scripts ? ['ci:deps', ...checks] : checks;
}
