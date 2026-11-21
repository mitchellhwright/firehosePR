import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  isStepActionEntryPath, isStepActionScriptPath, STEP_ACTION_ENTRY_INPUT,
  STEP_ACTION_REFERENCE, STEP_ACTION_SCRIPT_INPUT,
} from '../workflows/lib/stepActionContract.ts';
import { load } from 'js-yaml';

/**
 * Migration proof: a hand-written workflow and the generated one that replaces
 * it must describe the same job graph. Comments, quoting, key order and
 * whitespace inside an expression are presentation; a `run` block and the
 * script it moved into are the same shell. Everything else — triggers,
 * permissions, concurrency, every job's condition, dependencies, environment,
 * inputs and step order — must match exactly, so a migration commit can be
 * read as "nothing changed" with a test behind it rather than a claim.
 *
 * Deleted once every workflow is generated.
 */

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };

export interface NormalisedWorkflow {
  /**
   * A workflow's name is an operational input, not a label: a `workflow_run`
   * trigger subscribes to it by string, so a rename can disable a downstream
   * controller while every job in the graph still matches.
   */
  readonly name: Json;
  readonly triggers: Json;
  readonly permissions: Json;
  readonly concurrency: Json;
  readonly env: Json;
  readonly runName: Json;
  readonly jobs: Record<string, Json>;
}

/**
 * Omitting top-level `permissions` gives a job the repository's default token
 * scopes; declaring `permissions: {}` removes every scope. Normalising the
 * absent case to an empty map would make that change invisible, so it gets a
 * value no permission map can equal.
 */
const INHERITED_PERMISSIONS = 'inherited: no top-level permissions declared';

export interface NormaliseOptions {
  /** Repository root the `run` scripts are read from. */
  readonly root: string;
  /**
   * Visible name in the old workflow → its name in the new one, for jobs and
   * steps alike. Every rename a migration makes is declared here, so a rename
   * nobody intended still fails the comparison.
   */
  readonly renames?: Readonly<Record<string, string>>;
}

const SCRIPT_PROLOGUE = /^#!\/usr\/bin\/env bash\n(?:set -euo pipefail\n)?/;
const STEP_RUNNER_INVOCATION = /^bash (?:scripts\/ci\/lib\/run-step\.sh )?(scripts\/[^\s]+\.sh)$/;
const ANNOTATION_KEYS = new Set(['EXAMPLE_STEP_NAME', 'EXAMPLE_STEP_OWNER', 'EXAMPLE_STEP_NEXT_ACTION', 'EXAMPLE_SUMMARY_TITLE']);

/**
 * Fields whose value is an expression GitHub evaluates. YAML folding can move
 * whitespace around inside one without changing what it means, so only these —
 * and any value that carries a `${{ … }}` — have their whitespace collapsed.
 */
const EXPRESSION_KEYS = new Set(['if', 'name', 'run-name', 'group', 'cancel-in-progress', 'runs-on']);

/**
 * The synthesised key holding a step's shell body; never an expression.
 *
 * Deliberately not `shell`: a workflow step has a real `shell:` field naming
 * its interpreter, and writing the body under that name shadowed it, so
 * removing `shell: bash` from a step changed the generated YAML while the
 * proof stayed silent.
 */
const SHELL_KEY = 'shellBody';

/**
 * Collapse the whitespace YAML folding can move around inside an expression,
 * and only there. A shell body or an environment value is data: `echo "a  b"`
 * and `echo "a b"` run differently, so collapsing them would let a migration
 * alter what a step executes while the proof reported no change.
 */
/**
 * An expression as GitHub parses it, so the proof reports meaning and not
 * formatting. Three differences carry none:
 *
 * - `if: ${{ X }}` and `if: X` are the same condition; the emitter writes the
 *   bare form where the hand-written YAML wrapped it.
 * - Whitespace inside an expression is insignificant, and a folded `>` scalar
 *   introduces it wherever the source happened to wrap.
 * - So is padding immediately inside parentheses, for the same reason.
 *
 * Everything else still compares literally: a changed operand, a dropped
 * clause or a different function is a real difference and is reported.
 */
function canonicalExpression(value: string): string {
  return value
    .replace(/^\s*\$\{\{([\s\S]*)\}\}\s*$/, '$1')
    .replace(/\s+/g, ' ')
    .replace(/\(\s+/g, '(')
    .replace(/\s+\)/g, ')')
    .trim();
}

function canonicalScalar(value: string, key: string | undefined): string {
  if (key === SHELL_KEY) return value;
  return EXPRESSION_KEYS.has(key ?? '') || value.includes('${{')
    ? canonicalExpression(value)
    : value;
}

function canonical(value: unknown, key?: string): Json {
  if (value === null || value === undefined) return null;
  if (Array.isArray(value)) return value.map((entry) => canonical(entry, key));
  if (typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([, entry]) => entry !== undefined)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([entryKey, entry]) => [entryKey, canonical(entry, entryKey)]),
    );
  }
  if (typeof value === 'string') return canonicalScalar(value, key);
  if (typeof value === 'number' || typeof value === 'boolean') return value;
  return String(value);
}

/** The shell a step runs, whether it is inline or in the script it moved to. */
function shellOf(root: string, run: string): string {
  const invoked = STEP_RUNNER_INVOCATION.exec(run.trim());
  const scriptPath = invoked?.[1];
  if (scriptPath !== undefined) {
    return readFileSync(join(root, scriptPath), 'utf8').replace(SCRIPT_PROLOGUE, '').trimEnd();
  }
  return run.replace(/^set -euo pipefail\n/, '').trimEnd();
}

/**
 * What GitHub shows for a step that declares no `name`: the action it uses, or
 * the first line of its shell. Mirrors the job-id fallback — a rename map has
 * to be able to key on an unnamed step, because giving one a name is exactly
 * the kind of change a migration makes and must declare.
 */
function visibleStepName(step: Record<string, unknown>): string | undefined {
  const { name, uses, run } = step;
  if (typeof name === 'string') return name;
  if (typeof uses === 'string') return uses.split('@')[0];
  if (typeof run === 'string') return run.split('\n')[0]?.trim();
  return undefined;
}

function normaliseStep(step: Record<string, unknown>, options: NormaliseOptions): Json {
  const { run, env, name: _name, uses, with: withValues, ...rest } = step;
  const typedScript = uses === STEP_ACTION_REFERENCE && withValues !== null
    && typeof withValues === 'object' && !Array.isArray(withValues)
    ? (withValues as Record<string, unknown>)[STEP_ACTION_SCRIPT_INPUT]
    : undefined;
  const typedEntry = uses === STEP_ACTION_REFERENCE && withValues !== null
    && typeof withValues === 'object' && !Array.isArray(withValues)
    ? (withValues as Record<string, unknown>)[STEP_ACTION_ENTRY_INPUT]
    : undefined;
  if (uses === STEP_ACTION_REFERENCE && (
    !(isStepActionScriptPath(typedScript) || isStepActionEntryPath(typedEntry))
    || run !== undefined || rest.shell !== undefined
    || Object.keys(withValues as Record<string, unknown>).length !== 1
  )) {
    throw new Error(`${STEP_ACTION_REFERENCE} must declare one repository script or typed entry input`);
  }
  const visible = visibleStepName(step);
  const renamed = visible === undefined ? undefined : options.renames?.[visible] ?? visible;
  const declaredEnv = env === null || typeof env !== 'object'
    ? env
    : Object.fromEntries(Object.entries(env as Record<string, unknown>).filter(([key]) => !ANNOTATION_KEYS.has(key)));
  const hasEnv = declaredEnv !== null && typeof declaredEnv === 'object' && Object.keys(declaredEnv).length > 0;
  return canonical({
    ...rest,
    ...(typedScript === undefined ? { uses, with: withValues } : {}),
    ...(renamed === undefined ? {} : { name: renamed }),
    ...(hasEnv ? { env: declaredEnv } : {}),
    ...(typeof run === 'string' ? { [SHELL_KEY]: shellOf(options.root, run) }
      : typeof typedScript === 'string'
        ? { [SHELL_KEY]: shellOf(options.root, `bash ${typedScript}`) }
        : {}),
  });
}

/**
 * `on: { workflow_dispatch: }` and `on: { workflow_dispatch: {} }` are the
 * same trigger with no filters; only one of them can be written by a
 * generator, so an absent filter map normalises to the empty one.
 */
function normaliseTriggers(triggers: unknown): Json {
  if (triggers === null || typeof triggers !== 'object' || Array.isArray(triggers)) return canonical(triggers);
  return canonical(Object.fromEntries(
    Object.entries(triggers as Record<string, unknown>).map(([event, filters]) => [event, filters ?? {}]),
  ));
}

export function normaliseWorkflow(yamlText: string, options: NormaliseOptions): NormalisedWorkflow {
  const document = load(yamlText) as Record<string, unknown>;
  const jobs: Record<string, Json> = {};
  for (const [id, raw] of Object.entries((document.jobs ?? {}) as Record<string, Record<string, unknown>>)) {
    const { steps, name, needs, ...rest } = raw;
    // GitHub shows the job id when a job has no name, so that is the visible
    // name a rename replaces.
    const visible = typeof name === 'string' ? name : id;
    const renamed = options.renames?.[visible] ?? visible;
    jobs[id] = canonical({
      ...rest,
      // `needs: a` and `needs: [a]` are the same dependency; only one of them
      // can come out of a generator.
      ...(needs === undefined ? {} : { needs: Array.isArray(needs) ? needs : [needs] }),
      name: renamed,
      steps: Array.isArray(steps)
        ? steps.map((entry) => normaliseStep(entry as Record<string, unknown>, options))
        : [],
    });
  }
  const name = typeof document.name === 'string' ? options.renames?.[document.name] ?? document.name : document.name;
  return {
    name: canonical(name, 'name'),
    triggers: normaliseTriggers(document.on),
    permissions: Object.hasOwn(document, 'permissions')
      ? canonical(document.permissions)
      : INHERITED_PERMISSIONS,
    concurrency: canonical(document.concurrency ?? null),
    env: canonical(document.env ?? null),
    runName: canonical(document['run-name'] ?? null, 'run-name'),
    jobs,
  };
}

function difference(path: string, before: Json, after: Json, issues: string[]): void {
  if (JSON.stringify(before) === JSON.stringify(after)) return;
  const comparable = before !== null && after !== null
    && typeof before === 'object' && typeof after === 'object'
    && !Array.isArray(before) && !Array.isArray(after);
  if (!comparable) {
    issues.push(`${path} differs: ${JSON.stringify(before)} -> ${JSON.stringify(after)}`);
    return;
  }
  const keys = new Set([...Object.keys(before), ...Object.keys(after)]);
  for (const key of [...keys].sort()) {
    difference(`${path}.${key}`, before[key] ?? null, after[key] ?? null, issues);
  }
}

export interface CompareOptions {
  /**
   * The steps a migration adds, by job id, written out in full. Moving a `run`
   * block into `scripts/ci` makes a checkout mandatory where inline shell
   * needed none, so a few migrations genuinely add one step.
   *
   * The declaration carries the step's whole content, not just its name,
   * because a step the old workflow never had cannot be proved correct by
   * comparing it to the old workflow — the declaration is the only statement
   * of what it should be. Naming it alone was a blank cheque: a declared
   * checkout could take `ref: ${{ matrix.head }}` and `persist-credentials:
   * true` on a `pull_request_target` workflow and the comparison would stay
   * silent, which is the classic privilege-escalation shape.
   *
   * An allowance matching no added step, and an added step whose content
   * differs from its declaration, are both reported.
   */
  readonly addedSteps?: Readonly<Record<string, readonly Readonly<Record<string, unknown>>[]>>;
  /**
   * Repository root, so a declaration is normalised the same way the workflow
   * is: `run` becomes the shell it resolves to, and a declared script step
   * reads as the script's content. Without it a declaration written in
   * ordinary workflow syntax could never match the step it describes.
   */
  readonly root?: string;
  /**
   * The job ids to compare, for a workflow migrated one job at a time. A job
   * not listed here is left out of the comparison rather than reported as
   * removed, so the proof is a test that runs from the first migrated job
   * instead of one that only arrives with the last.
   *
   * A selected id neither workflow declares is itself reported: a typo in the
   * list would otherwise turn the whole comparison into a silent no-op, which
   * is the one failure mode a migration proof cannot have.
   *
   * Deleted with the rest of this module once ios-tests is generated in full.
   */
  readonly jobs?: readonly string[];
}

function stepName(step: Json): string {
  return typeof step === 'object' && step !== null && !Array.isArray(step) && typeof step.name === 'string'
    ? step.name
    : '';
}

/** Empty when the two workflows describe the same job graph. */
export function equivalenceIssues(
  before: NormalisedWorkflow,
  after: NormalisedWorkflow,
  options: CompareOptions = {},
): string[] {
  const issues: string[] = [];
  difference('name', before.name, after.name, issues);
  difference('triggers', before.triggers, after.triggers, issues);
  difference('permissions', before.permissions, after.permissions, issues);
  difference('concurrency', before.concurrency, after.concurrency, issues);
  difference('env', before.env, after.env, issues);
  difference('run-name', before.runName, after.runName, issues);

  const declared = [...new Set([...Object.keys(before.jobs), ...Object.keys(after.jobs)])].sort();
  const selected = options.jobs === undefined ? undefined : new Set(options.jobs);
  for (const id of selected ?? []) {
    if (!declared.includes(id)) issues.push(`jobs.${id} is selected for comparison but neither workflow declares it`);
  }

  for (const id of declared) {
    if (selected !== undefined && !selected.has(id)) continue;
    const left = before.jobs[id];
    const right = after.jobs[id];
    if (left === undefined || right === undefined) {
      issues.push(`jobs.${id} ${left === undefined ? 'added' : 'removed'}`);
      continue;
    }
    const leftSteps = (left as { steps?: Json[] }).steps ?? [];
    // Every declaration is kept, not one per name: two additions can share a
    // visible name, and keying by name alone would drop all but the last, so
    // a declaration with no step behind it would go unreported.
    const unmatched = new Map<string, Readonly<Record<string, unknown>>[]>();
    for (const declared of options.addedSteps?.[id] ?? []) {
      const name = String(declared.name ?? '');
      unmatched.set(name, [...(unmatched.get(name) ?? []), declared]);
    }
    const rightSteps = ((right as { steps?: Json[] }).steps ?? []).filter((step) => {
      const name = stepName(step);
      const pending = unmatched.get(name);
      const declared = pending?.shift();
      if (declared === undefined) return true;
      if (pending !== undefined && pending.length === 0) unmatched.delete(name);
      // Normalised the same way the workflow was, so a declaration written in
      // ordinary workflow syntax compares against the step it describes.
      const expected = normaliseStep(declared as Record<string, unknown>, { root: options.root ?? process.cwd() });
      difference(`jobs.${id}.steps[added ${JSON.stringify(name)}]`, expected, step, issues);
      return false;
    });
    for (const [missing, pending] of unmatched) {
      for (let index = 0; index < pending.length; index += 1) {
        issues.push(`jobs.${id}.steps declares an added step ${JSON.stringify(missing)} that is not there`);
      }
    }
    if (leftSteps.length !== rightSteps.length) {
      issues.push(`jobs.${id}.steps count ${leftSteps.length} -> ${rightSteps.length}`);
    }
    leftSteps.forEach((stepBefore, index) => {
      difference(`jobs.${id}.steps[${index + 1}]`, stepBefore, rightSteps[index] ?? null, issues);
    });
    const { steps: _leftSteps, ...leftRest } = left as Record<string, Json>;
    const { steps: _rightSteps, ...rightRest } = right as Record<string, Json>;
    difference(`jobs.${id}`, leftRest, rightRest, issues);
  }
  return issues.sort();
}
