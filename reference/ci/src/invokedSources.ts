import { existsSync, readFileSync } from 'node:fs';
import { dirname, relative, resolve } from 'node:path';
import {
  STEP_ACTION_ENTRY_INPUT, STEP_ACTION_REFERENCE, STEP_ACTION_SCRIPT_INPUT,
} from '../workflows/lib/stepActionContract.ts';

/**
 * The sources a workflow step's shell actually reaches.
 *
 * Both static contracts — `stepOutputs.ts` for `$GITHUB_OUTPUT` and
 * `envContract.ts` for `$GITHUB_ENV` — pin the names a step writes through a
 * script rather than inline, and each verifies its pins against the source.
 * They resolved that source the same way, so it is resolved here once.
 *
 * A typed step program is the reason this is more than a regex over the step's
 * shell: `run: node ci/src/actions/ios/<program>.ts` names one file, but the
 * names it writes live in the decision module it imports. Following those
 * imports is what keeps a pin evidence-backed instead of a bare assertion.
 *
 * Deliberately free of package imports: the validation-policy lane loads the
 * modules that depend on this one and installs nothing.
 */

export interface InvokingStep {
  readonly run?: string | undefined;
  readonly uses?: string | undefined;
  readonly with?: Readonly<Record<string, unknown>> | undefined;
}

/**
 * The text naming what a step runs: its `run` shell, or the one entry or
 * script the generated typed step action receives as input. Contracts that
 * follow a step into its sources read this, so moving a step from shell to a
 * typed entry keeps its pinned outputs, environment and checkout coverage
 * evidence-backed.
 */
export function stepInvocation(step: InvokingStep): string {
  if (step.run !== undefined) return step.run;
  if (step.uses !== STEP_ACTION_REFERENCE) return '';
  const input = step.with?.[STEP_ACTION_ENTRY_INPUT] ?? step.with?.[STEP_ACTION_SCRIPT_INPUT];
  return typeof input === 'string' ? input : '';
}

const invokedScriptPattern = /((?:scripts|ci\/src)\/[\w./-]+\.(?:sh|mjs|js|py|ts))/g;
const typedImportPattern = /from\s+'(\.[\w./-]+\.ts)'/g;

/** Every local `.ts` module a typed program imports, transitively. */
function typedModuleImports(repositoryRoot: string, entry: string): readonly string[] {
  const reached: string[] = [];
  const seen = new Set<string>();
  const queue = [resolve(repositoryRoot, entry)];
  while (queue.length > 0) {
    const path = queue.shift();
    if (path === undefined || seen.has(path)) continue;
    seen.add(path);
    if (!path.endsWith('.ts') || !existsSync(path)) continue;
    for (const match of readFileSync(path, 'utf8').matchAll(typedImportPattern)) {
      const specifier = match[1];
      if (specifier === undefined) continue;
      const imported = resolve(dirname(path), specifier);
      reached.push(relative(repositoryRoot, imported));
      queue.push(imported);
    }
  }
  return reached;
}

/**
 * Scripts a shell block runs, the scripts each of those runs in turn — one
 * level of delegation — and the modules a typed program imports.
 */
export function invokedScripts(repositoryRoot: string, run: string): readonly string[] {
  const direct = [...run.matchAll(invokedScriptPattern)].map((match) => match[1] ?? '');
  const delegated = direct.flatMap((script) => {
    const scriptPath = resolve(repositoryRoot, script);
    if (!existsSync(scriptPath)) return [];
    return [...readFileSync(scriptPath, 'utf8').matchAll(invokedScriptPattern)].map(
      (match) => match[1] ?? '',
    );
  });
  const imported = direct.flatMap((script) => typedModuleImports(repositoryRoot, script));
  return [...new Set([...direct, ...delegated, ...imported])];
}

/**
 * Whether any of those sources names `key`: as `key=`, as a quoted literal, as
 * an object-literal `key:`, or as the shorthand `key,`. Over-approximated on
 * purpose — the same way the shell parsers over-approximate — so the pin
 * catches a name that has disappeared rather than every way it could be used.
 */
export function scriptNamesKey(
  repositoryRoot: string,
  scripts: readonly string[],
  key: string,
): boolean {
  const spellings = [`${key}=`, `'${key}'`, `"${key}"`, `${key}:`, `${key},`];
  return scripts.some((script) => {
    const scriptPath = resolve(repositoryRoot, script);
    if (!existsSync(scriptPath)) return false;
    const source = readFileSync(scriptPath, 'utf8');
    return spellings.some((spelling) => source.includes(spelling));
  });
}
