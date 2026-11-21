import {
  job, step, workflow,
  type ConditionLike, type ConfigValue, type ExpressionValue, type Job, type Permissions,
  type RunsOn, type Step, type StepConfig, type StepsJobConfig, type Workflow, type WorkflowConfig,
} from 'gagen';
import { existsSync } from 'node:fs';
import { z } from 'zod';
import {
  costClassSchema, evidencePolicySchema, failureOwnerSchema, requiredCheckContextSchema,
  runnerClassSchema, selectionOwnerSchema, statusUnitSchema, uiSemanticCategorySchema,
  type RequiredCheckContext,
} from '../../src/workflowContract.ts';
import { renderName, renderedLiterals, validateName, type NameSpec } from './names.ts';
import { STEP_ACTION_ENTRY_INPUT, STEP_ACTION_REFERENCE, STEP_ACTION_SCRIPT_INPUT, isStepActionEntryPath } from './stepActionContract.ts';
import type { ValidationPullRequestEvent } from './events.ts';
import { MERGE_GROUP_TRIGGER, type SupportedCiEvent } from './ciEvent.ts';

/**
 * A workflow definition carries what GitHub needs and what a person needs.
 * GitHub needs the job graph; a person reading a red check needs the step's
 * name, who owns the failure and what to do next. Both come from the same
 * object, so a step cannot exist without an owner, a purpose and a recovery
 * sentence, and the registry the controllers read is a projection of these
 * definitions rather than a file that can drift from them.
 *
 * Shell lives in `scripts/ci/…`, never inline: `run` here is one line by
 * construction, which keeps every line of shell under shellcheck and lets the
 * step runner wrap failures with the owner and next action.
 */

export type FailureOwner = z.infer<typeof failureOwnerSchema>;
export type SemanticCategory = z.infer<typeof uiSemanticCategorySchema>;
export type StatusUnit = z.infer<typeof statusUnitSchema>;
export type RunnerClass = z.infer<typeof runnerClassSchema>;
export type CostClass = z.infer<typeof costClassSchema>;
export type EvidencePolicy = z.infer<typeof evidencePolicySchema>;
export type SelectionOwner = z.infer<typeof selectionOwnerSchema>;

/** The wrapper that annotates a failing script with its owner and next action. */
export const STEP_RUNNER = 'scripts/ci/lib/run-step.sh';

export interface StepDoc {
  /** What the step does, in one sentence, for the UI contract. */
  readonly purpose: string;
  /** What the owner should do when it fails, in one sentence, shown in the annotation. */
  readonly recovery: string;
}

const stepDocSchema = z.object({
  purpose: z.string().trim().min(10).max(240),
  recovery: z.string().trim().min(5).max(240),
});

const jobDocSchema = z.object({
  purpose: z.string().trim().min(10).max(240),
  successMeaning: z.string().trim().min(10).max(240),
});

export interface TypedStepConfig<O extends string = never> {
  readonly id?: string;
  readonly name: NameSpec;
  readonly doc: StepDoc;
  readonly owner: FailureOwner;
  readonly category: SemanticCategory;
  readonly unit: StatusUnit;
  /** A script under `scripts/`; the only way to run more than one line of shell. */
  readonly script?: `scripts/${string}`;
  /** A compiler-checked TypeScript entrypoint executed by the generated Node action. */
  readonly entry?: `ci/src/actions/${string}.ts`;
  /** Temporary migration choice while remaining scripts leave the shared shell wrapper. */
  readonly scriptExecution?: 'typed-action';
  /** A single-line command, for the cases where a script would be one `echo`. */
  readonly command?: string;
  /**
   * Permission for `command` to span lines, with the reason written down.
   *
   * Shell belongs in `scripts/ci` so it can be linted and wrapped — but that
   * assumes the shell and the workflow are the same revision. A job that
   * deliberately runs a *different* revision's code breaks the assumption:
   * its scripts do not exist at the revision it checks out, and it fails with
   * "No such file or directory" until they do. For those jobs the shell has
   * to travel inside the workflow file, which is the revision they trust.
   */
  readonly inlineShell?: { readonly reason: string };
  readonly uses?: string;
  readonly with?: Readonly<Record<string, ConfigValue>>;
  readonly env?: Readonly<Record<string, ConfigValue>>;
  readonly if?: ConditionLike;
  readonly continueOnError?: boolean | string;
  readonly timeoutMinutes?: number;
  readonly workingDirectory?: string;
  readonly shell?: string;
  readonly outputs?: readonly O[];
  /** Controllers: the heading the script writes to `GITHUB_STEP_SUMMARY`. */
  readonly summaryTitle?: string;
  /**
   * Job names this step's script spells out, taken from the definition that
   * renders them. A `.sh` cannot import the generated name module the way a
   * Node controller does, so the pin travels with the step instead:
   * `ci/tests/workflows.consumerNames.test.ts` proves the script still
   * contains every name pinned here, which turns a rename into a failing test
   * rather than a controller that quietly matches nothing.
   */
  readonly pinnedNames?: readonly string[];
}

export interface TypedStep<O extends string = never> {
  readonly config: TypedStepConfig<O>;
  readonly step: Step<O>;
  readonly outputs: { [K in O]: ExpressionValue };
}

/** A local-action script cannot also declare a run command or action inputs. */
export type TypedScriptActionConfig<O extends string = never> =
  Omit<TypedStepConfig<O>, 'script' | 'scriptExecution' | 'command' | 'uses' | 'with' | 'shell'> & {
    readonly script: `scripts/${string}`;
    readonly command?: never;
    readonly uses?: never;
    readonly with?: never;
    readonly shell?: never;
  };

export function typedScriptActionStep<const O extends string = never>(
  config: TypedScriptActionConfig<O>,
): TypedStep<O> {
  return typedStep({ ...config, scriptExecution: 'typed-action' });
}

/** One TypeScript entrypoint with no shell, action-input, or working-directory escape hatch. */
export type TypedNodeActionConfig<O extends string = never> =
  Omit<TypedStepConfig<O>, 'script' | 'entry' | 'scriptExecution' | 'command' | 'uses' | 'with' | 'shell' | 'workingDirectory'> & {
    readonly entry: `ci/src/actions/${string}.ts`;
    readonly script?: never;
    readonly command?: never;
    readonly uses?: never;
    readonly with?: never;
    readonly shell?: never;
    readonly workingDirectory?: never;
  };

export function typedNodeActionStep<const O extends string = never>(config: TypedNodeActionConfig<O>): TypedStep<O> {
  return typedStep(config);
}

function fail(where: string, message: string): never {
  throw new Error(`${where}: ${message}`);
}

function formatIssues(error: z.ZodError): string {
  return error.issues.map((issue) => `${issue.path.join('.') || 'value'} ${issue.message}`).join('; ');
}

export function typedStep<const O extends string = never>(config: TypedStepConfig<O>): TypedStep<O> {
  const readable = String(renderName(config.name));
  const where = `step ${JSON.stringify(readable)}`;

  const kinds = [config.script, config.entry, config.command, config.uses].filter((value) => value !== undefined);
  if (kinds.length !== 1) fail(where, 'exactly one of script, entry, command or uses is required');
  if (config.entry !== undefined && !isStepActionEntryPath(config.entry)) {
    fail(where, 'entry must be a typechecked TypeScript file under ci/src/actions/');
  }
  if (config.entry !== undefined && !existsSync(config.entry)) {
    fail(where, `entry does not exist: ${config.entry}`);
  }
  if (config.command?.includes('.mjs') || config.script?.endsWith('.mjs')) {
    fail(where, 'workflow execution must use a typechecked TypeScript entrypoint, not .mjs');
  }
  if (config.command?.includes('\n') && config.inlineShell === undefined) {
    fail(where, 'a command is one line; put longer shell in a script under scripts/ci');
  }
  if (config.inlineShell !== undefined && config.inlineShell.reason.trim().length < 20) {
    fail(where, 'inlineShell needs a reason saying why this shell cannot live in scripts/ci');
  }
  if (config.inlineShell !== undefined && config.script !== undefined) {
    fail(where, 'inlineShell describes a command that stays in the workflow; it cannot pair with a script');
  }
  if (config.scriptExecution !== undefined && config.script === undefined) {
    fail(where, 'scriptExecution requires a script step');
  }
  if (config.scriptExecution === 'typed-action' && (config.with !== undefined || config.shell !== undefined)) {
    fail(where, 'a typed-action script owns its input and Bash interpreter');
  }
  if (config.entry !== undefined && (config.with !== undefined || config.shell !== undefined || config.inlineShell !== undefined)) {
    fail(where, 'a typed entry owns its action input and Node interpreter');
  }
  // `run` is resolved against `working-directory`, so a step that sets both
  // would look for the runner and the script beneath that directory and fail
  // with "No such file or directory". A script that needs a different working
  // directory changes into it itself, where the reason can be written down.
  if ((config.script !== undefined || config.entry !== undefined) && config.workingDirectory !== undefined) {
    fail(where, 'a script or entry step cannot set workingDirectory: it runs from the workspace root');
  }
  const nameIssues = validateName(config.name);
  if (nameIssues.length > 0) fail(where, nameIssues.join('; '));
  const doc = stepDocSchema.safeParse(config.doc);
  if (!doc.success) fail(where, `doc: ${formatIssues(doc.error)}`);
  failureOwnerSchema.parse(config.owner);
  uiSemanticCategorySchema.parse(config.category);
  statusUnitSchema.parse(config.unit);
  if (config.category === 'coordination' && config.script !== undefined && !config.summaryTitle) {
    fail(where, 'summaryTitle is required for a coordination script step: it must say what it decided in the run summary');
  }
  // Only a script can spell a name out; `uses` and a one-line `command` are in
  // the definition already, where a rename reaches them by construction.
  if (config.pinnedNames !== undefined && config.script === undefined) {
    fail(where, 'pinnedNames belongs on a script step: nothing else here spells a name out of band');
  }
  if (config.pinnedNames?.some((name) => name.trim() === '')) {
    fail(where, 'every pinned name must be a name the script contains');
  }

  // The annotation contract: every script failure names the step, its owner
  // and the next action, without the script having to know any of them.
  const annotations: Record<string, ConfigValue> = config.script === undefined && config.entry === undefined ? {} : {
    EXAMPLE_STEP_NAME: readable,
    EXAMPLE_STEP_OWNER: config.owner,
    EXAMPLE_STEP_NEXT_ACTION: config.doc.recovery,
    ...(config.summaryTitle === undefined ? {} : { EXAMPLE_SUMMARY_TITLE: config.summaryTitle }),
  };
  const env = { ...annotations, ...config.env };
  const run = config.script === undefined ? config.command
    : config.scriptExecution === 'typed-action' ? undefined
      : `bash ${STEP_RUNNER} ${config.script}`;
  const uses = config.scriptExecution === 'typed-action' || config.entry !== undefined ? STEP_ACTION_REFERENCE : config.uses;
  const withValues = config.entry !== undefined ? { [STEP_ACTION_ENTRY_INPUT]: config.entry }
    : config.scriptExecution === 'typed-action' ? { [STEP_ACTION_SCRIPT_INPUT]: config.script } : config.with;

  const built = step<O>({
    ...(config.id === undefined ? {} : { id: config.id }),
    name: readable,
    ...(uses === undefined ? {} : { uses }),
    ...(run === undefined ? {} : { run }),
    ...(withValues === undefined ? {} : { with: withValues }),
    ...(Object.keys(env).length === 0 ? {} : { env }),
    ...(config.if === undefined ? {} : { if: config.if }),
    ...(config.shell === undefined ? {} : { shell: config.shell }),
    ...(config.workingDirectory === undefined ? {} : { workingDirectory: config.workingDirectory }),
    ...(config.continueOnError === undefined ? {} : { continueOnError: config.continueOnError }),
    ...(config.timeoutMinutes === undefined ? {} : { timeoutMinutes: config.timeoutMinutes }),
    ...(config.outputs === undefined ? {} : { outputs: config.outputs }),
  } as StepConfig<O>);

  return { config, step: built, outputs: built.outputs };
}

export interface LaneMetadata {
  readonly runnerClass: RunnerClass;
  readonly costClass: CostClass;
  readonly evidencePolicy: EvidencePolicy;
  readonly selectionOwner: SelectionOwner;
}

export interface JobDoc {
  readonly purpose: string;
  readonly successMeaning: string;
}

export interface TypedJobConfig {
  readonly name: NameSpec;
  /**
   * Unanchored regular-expression alternatives for names this job used to
   * render. A run that started before a rename merged is still reported under
   * the old name, so a consumer has to recognise both until those runs age
   * out. Declared here, generated into the published matcher, and deleted here
   * — a consumer never spells either form itself.
   */
  readonly retiredNamePatterns?: readonly string[];
  /**
   * The check context a branch ruleset lists for this job, declared only when
   * that name would otherwise be too generic to publish. "Test - iOS" is the
   * iOS aggregate's required context on develop and main: it cannot be renamed
   * without stopping the gate, so this job publishes it as it is.
   *
   * It is a declaration, not an escape: `typedWorkflow` refuses it unless the
   * job really is in that workflow's `requiredContexts` and really renders
   * this name, which keeps the exemption on the job the ruleset names rather
   * than on every name of that shape.
   */
  readonly requiredCheckContext?: RequiredCheckContext;
  readonly doc: JobDoc;
  readonly owner: FailureOwner;
  readonly category: SemanticCategory;
  readonly unit: StatusUnit;
  readonly runsOn: RunsOn;
  /**
   * A deployment environment, which is where a job's secrets and its approval
   * and branch protections come from. It is part of who may run the job, not
   * decoration, so it belongs on the definition rather than being applied to
   * the generated YAML afterwards.
   */
  readonly environment?: StepsJobConfig['environment'];
  readonly lane: LaneMetadata;
  readonly steps: readonly TypedStep<string>[];
  readonly needs?: readonly TypedJob[];
  readonly if?: ConditionLike;
  readonly permissions?: Permissions;
  readonly concurrency?: { readonly group: string | ExpressionValue; readonly cancelInProgress?: boolean | string };
  readonly env?: Readonly<Record<string, ConfigValue>>;
  readonly timeoutMinutes?: number;
  readonly continueOnError?: boolean | string;
  /**
   * What every `run` step in the job inherits. The Xcode lanes work out of
   * `ios/`, which is one statement here rather than a `working-directory` on
   * each of a dozen steps — and a step that forgot it would resolve its paths
   * against the workspace root and fail somewhere else.
   */
  readonly defaults?: StepsJobConfig['defaults'];
  readonly strategy?: StepsJobConfig['strategy'];
  readonly outputs?: Readonly<Record<string, ExpressionValue>>;
}

export interface TypedJob<I extends string = string, O extends string = never> {
  readonly id: I;
  readonly config: TypedJobConfig;
  readonly job: Job;
  readonly outputs: Readonly<Record<O, ExpressionValue>>;
}

type JobOutputName<C extends TypedJobConfig> = C['outputs'] extends Readonly<Record<string, ExpressionValue>>
  ? Extract<keyof C['outputs'], string>
  : never;

export function typedJob<const I extends string, const C extends TypedJobConfig>(
  id: I, config: C,
): TypedJob<I, JobOutputName<C>> {
  const where = `job ${id}`;
  if (!/^[a-z][a-z0-9-]*$/.test(id)) fail(where, 'job ids are kebab-case');
  if (config.requiredCheckContext !== undefined) requiredCheckContextSchema.parse(config.requiredCheckContext);
  const nameIssues = validateName(config.name, config.requiredCheckContext);
  if (nameIssues.length > 0) fail(where, nameIssues.join('; '));
  const doc = jobDocSchema.safeParse(config.doc);
  if (!doc.success) fail(where, `doc: ${formatIssues(doc.error)}`);
  failureOwnerSchema.parse(config.owner);
  uiSemanticCategorySchema.parse(config.category);
  statusUnitSchema.parse(config.unit);
  runnerClassSchema.parse(config.lane.runnerClass);
  costClassSchema.parse(config.lane.costClass);
  evidencePolicySchema.parse(config.lane.evidencePolicy);
  selectionOwnerSchema.parse(config.lane.selectionOwner);
  if (config.steps.length === 0) fail(where, 'a job runs at least one step');

  const seen = new Set<string>();
  for (const typed of config.steps) {
    const literal = String(renderName(typed.config.name));
    if (seen.has(literal)) fail(where, `duplicate step name ${JSON.stringify(literal)}`);
    seen.add(literal);
  }

  // Inline shell needs nothing on disk; a script does. Moving a `run` block
  // into scripts/ci therefore makes a checkout mandatory in the same job, and
  // a job that skips it fails at the first script with "No such file or
  // directory" — or, on a reused self-hosted workspace, runs whatever the last
  // job left behind. That is a silent behaviour change during a migration, so
  // it is refused here rather than discovered on a scheduled run.
  const checkoutIndex = config.steps.findIndex((typed) => typed.config.uses?.startsWith('actions/checkout@'));
  const scriptIndex = config.steps.findIndex((typed) => typed.config.script !== undefined || typed.config.entry !== undefined);
  if (scriptIndex !== -1 && (checkoutIndex === -1 || checkoutIndex > scriptIndex)) {
    const script = config.steps[scriptIndex]?.config.script ?? config.steps[scriptIndex]?.config.entry;
    fail(where, `${script} runs from the workspace, so this job needs an actions/checkout step before it`);
  }
  const entryIndex = config.steps.findIndex((typed) => typed.config.entry !== undefined);
  const nodeIndex = config.steps.findIndex((typed) => typed.config.uses?.startsWith('actions/setup-node@'));
  if (entryIndex !== -1 && (nodeIndex === -1 || nodeIndex > entryIndex)) {
    fail(where, 'a typed entry needs actions/setup-node before it so its tested Node version matches the job toolchain');
  }

  const built = job(id, {
    name: renderName(config.name),
    runsOn: config.runsOn,
    steps: config.steps.map((typed) => typed.step),
    ...(config.needs === undefined ? {} : { needs: config.needs.map((typed) => typed.job) }),
    ...(config.defaults === undefined ? {} : { defaults: config.defaults }),
    ...(config.environment === undefined ? {} : { environment: config.environment }),
    ...(config.if === undefined ? {} : { if: config.if }),
    ...(config.permissions === undefined ? {} : { permissions: config.permissions }),
    ...(config.concurrency === undefined ? {} : {
      concurrency: {
        group: String(config.concurrency.group),
        ...(config.concurrency.cancelInProgress === undefined
          ? {}
          : { cancelInProgress: config.concurrency.cancelInProgress }),
      },
    }),
    ...(config.env === undefined ? {} : { env: config.env }),
    ...(config.timeoutMinutes === undefined ? {} : { timeoutMinutes: config.timeoutMinutes }),
    ...(config.continueOnError === undefined ? {} : { continueOnError: config.continueOnError }),
    ...(config.defaults === undefined ? {} : { defaults: config.defaults }),
    ...(config.strategy === undefined ? {} : { strategy: config.strategy }),
    ...(config.outputs === undefined ? {} : { outputs: config.outputs }),
  });

  return { id, config, job: built, outputs: built.outputs as Record<JobOutputName<C>, ExpressionValue> };
}

/**
 * One job of another definition, by id. A workflow that names a job of another
 * workflow — a `workflow_run` subscription, a name a script matches on — reads
 * it from here, so deleting or renaming that job breaks generation instead of
 * leaving a string behind that matches nothing.
 */
export function jobOf(definition: WorkflowDefinition, id: string): TypedJob {
  const found = definition.config.jobs.find((candidate) => candidate.id === id);
  if (found === undefined) fail(`workflow ${definition.config.path}`, `has no job ${JSON.stringify(id)}`);
  return found;
}

export interface TypedWorkflowConfig {
  readonly path: `.github/workflows/${string}.yml`;
  readonly source: `ci/workflows/${string}.ts`;
  readonly name: string;
  /**
   * The name the UI contract publishes, when `name` cannot be it. A workflow's
   * `name` is an operational input — the review controller and the base-update
   * classifier both subscribe to "PR Checks" by string — so a name that reads
   * badly cannot simply be rewritten here: that rename has to move every
   * subscriber with it, in its own change. Until then this is the readable
   * name, and the gap between the two is what the legacy UI debt records.
   */
  readonly displayName?: string;
  readonly doc: { readonly purpose: string };
  readonly on: WorkflowConfig['on'];
  readonly permissions: Permissions;
  readonly jobs: readonly TypedJob[];
  readonly runName?: string | ExpressionValue;
  readonly concurrency?: {
    readonly group: string | ExpressionValue;
    readonly cancelInProgress?: boolean | string;
    /** GitHub's pending-run policy; rendered after gagen, which does not expose it yet. */
    readonly queue?: 'single' | 'max';
  };
  readonly env?: Readonly<Record<string, ConfigValue>>;
  /** Job ids whose rendered name is a required check context on develop and main. */
  readonly requiredContexts?: readonly string[];
}

/**
 * A required PR check may run for an actual validation event, never a generic
 * `edited` event. GitHub cannot filter edits by changed field at subscription
 * time; a skipped metadata run can shadow successful required check contexts.
 * Base-retarget edits belong to the trusted continuity workflow instead.
 */
export interface TypedRequiredPrWorkflowConfig extends TypedWorkflowConfig {
  readonly on: RequiredWorkflowTriggers;
  readonly requiredContexts: readonly string[];
}

/**
 * The triggers of a workflow that produces required contexts. Every one of
 * them is a supported CI event, and `merge_group` is mandatory: a required
 * context the queue candidate never receives removes every queue entry.
 */
export type RequiredWorkflowTriggers = {
  readonly pull_request: { readonly branches?: string[]; readonly types: ValidationPullRequestEvent[] };
  readonly merge_group: typeof MERGE_GROUP_TRIGGER;
  readonly workflow_dispatch?: Record<string, unknown>;
};

type SameKeys<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;
/** Compile-time: the required triggers and the supported event projections name the same events. */
const requiredTriggersAreSupportedEvents: SameKeys<keyof RequiredWorkflowTriggers, SupportedCiEvent> = true;
void requiredTriggersAreSupportedEvents;

export function typedRequiredPrWorkflow(config: TypedRequiredPrWorkflowConfig): WorkflowDefinition {
  return typedWorkflow(config);
}

export interface WorkflowDefinition {
  readonly config: TypedWorkflowConfig;
  readonly workflow: Workflow;
}

/**
 * npm's cache directory for every job, inside the runner's own tool cache.
 *
 * Self-hosted listeners that share a host also share its user, and so the
 * user's default `~/.npm`: t-runner-2 and tg-1 both run as `example-user`, and
 * instaip2's control and lane listeners both run as `example-runner`. Concurrent
 * `npm ci` runs there race on cacache's directory creation and fail with
 * `EEXIST: file already exists, mkdir '~/.npm/_cacache/index-v5/…'`.
 * `RUNNER_TOOL_CACHE` is `<runner install>/_work/_tool`, one per listener and
 * persistent, so each listener keeps a warm cache nobody else writes to.
 *
 * The runner sets `RUNNER_TOOL_CACHE` for every step, but workflow and job `env`
 * cannot read the `runner` context, so the value is the literal
 * `${RUNNER_TOOL_CACHE}` reference, which npm expands when it reads its
 * configuration. `ci/tests/npmCacheIsolation.test.ts` proves both halves.
 */
export const RUNNER_NPM_CACHE_ENV = { npm_config_cache: '${RUNNER_TOOL_CACHE}/npm-cache' } as const;

export function typedWorkflow(config: TypedWorkflowConfig): WorkflowDefinition {
  const where = `workflow ${config.path}`;
  if (config.jobs.length === 0) fail(where, 'a workflow declares at least one job');
  if (config.env !== undefined && Object.keys(config.env).some((name) => name.toLowerCase() === 'npm_config_cache')) {
    fail(where, 'npm_config_cache is set for every workflow by RUNNER_NPM_CACHE_ENV; do not override it');
  }
  const displayIssues = validateName(config.displayName ?? config.name);
  if (displayIssues.length > 0) fail(where, `displayName: ${displayIssues.join('; ')}`);
  const names = new Set<string>();
  const ids = new Set<string>();
  for (const typed of config.jobs) {
    const literal = String(renderName(typed.config.name));
    if (names.has(literal)) fail(where, `duplicate job name ${JSON.stringify(literal)}`);
    if (ids.has(typed.id)) fail(where, `duplicate job id ${JSON.stringify(typed.id)}`);
    names.add(literal);
    ids.add(typed.id);
  }
  for (const id of config.requiredContexts ?? []) {
    if (!ids.has(id)) fail(where, `requiredContexts names unknown job ${JSON.stringify(id)}`);
  }

  // A job may publish a generic name only where a branch ruleset already
  // names it. Both halves are checked here because only the workflow knows
  // both: the job says which context it publishes, and `requiredContexts`
  // says whether this workflow actually requires it.
  const required = new Set(config.requiredContexts ?? []);
  for (const typed of config.jobs) {
    const context = typed.config.requiredCheckContext;
    if (context === undefined) continue;
    if (!required.has(typed.id)) {
      fail(where, `job ${typed.id} declares the required context ${JSON.stringify(context)} `
        + 'but requiredContexts does not list it');
    }
    if (!renderedLiterals(typed.config.name).includes(context)) {
      fail(where, `job ${typed.id} declares the required context ${JSON.stringify(context)} `
        + 'but never renders that name');
    }
  }

  const built = workflow({
    name: config.name,
    on: config.on,
    permissions: config.permissions,
    jobs: config.jobs.map((typed) => typed.job),
    ...(config.runName === undefined ? {} : { runName: String(config.runName) }),
    ...(config.concurrency === undefined ? {} : {
      concurrency: {
        group: String(config.concurrency.group),
        ...(config.concurrency.cancelInProgress === undefined
          ? {}
          : { cancelInProgress: config.concurrency.cancelInProgress }),
      },
    }),
    env: { ...config.env, ...RUNNER_NPM_CACHE_ENV },
  });

  return { config, workflow: built };
}
