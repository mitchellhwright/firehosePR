import { prValidationPlanning } from '../../src/prValidationPlanning.ts';
import {
  computeRegistryDigest, requiredCheckContextSchema, uiContract,
  type RequiredCheckContext, type WorkflowContractRegistry, type WorkflowLaneContract,
} from '../../src/workflowContract.ts';
import type { FailureOwner, TypedJob, TypedStep, WorkflowDefinition } from './model.ts';
import { jobLiteralName, renderName, renderedLiterals } from './names.ts';

/**
 * The definitions are the contract; these are the views of them that
 * controllers, tests and telemetry read. Each is a pure function of the
 * definitions, so nothing downstream can name a workflow, job or step that
 * does not exist, and none of it can drift from what GitHub runs.
 */

function slug(displayName: string): string {
  return displayName.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
}

/** `<Owner> owner: for <name>, <the step's own recovery sentence>.` */
function nextAction(owner: FailureOwner, displayName: string, recovery: string): string {
  const capitalised = `${owner[0]?.toUpperCase() ?? ''}${owner.slice(1)}`;
  const sentence = recovery.endsWith('.') ? recovery.slice(0, -1) : recovery;
  return `${capitalised} owner: for ${displayName}, ${sentence}.`;
}

function stepContract(typed: TypedStep<string>, position: number) {
  const displayName = renderedLiterals(typed.config.name)[0] ?? '';
  const base = uiContract('step', displayName, typed.config.category, typed.config.owner, typed.config.unit);
  return {
    ...base,
    // The definition's own sentences beat the category's generic ones: this
    // is the text a person reads on a red check.
    purpose: typed.config.doc.purpose,
    nextAction: nextAction(typed.config.owner, displayName, typed.config.doc.recovery),
    id: typed.config.id ?? slug(displayName),
    ...(typed.config.id === undefined ? {} : { workflowStepId: typed.config.id }),
    position,
  };
}

function jobContract(typed: TypedJob, isRequiredContext = false) {
  const displayName = renderedLiterals(typed.config.name)[0] ?? '';
  // A job the workflow declares as a required context may carry a name the
  // readability rule would otherwise reject — it is branch protection's name,
  // not ours to change.
  const base = uiContract(
    'job', displayName, typed.config.category, typed.config.owner, typed.config.unit, isRequiredContext,
  );
  return {
    ...base,
    purpose: typed.config.doc.purpose,
    successMeaning: typed.config.doc.successMeaning,
    id: typed.id,
    steps: typed.config.steps.map((step, index) => stepContract(step, index + 1)),
  };
}

function canonicalConcurrency(
  concurrency: {
    readonly group: unknown;
    readonly cancelInProgress?: boolean | string;
    readonly queue?: 'single' | 'max';
  } | undefined,
): string | undefined {
  if (concurrency === undefined) return undefined;
  return JSON.stringify({
    'cancel-in-progress': concurrency.cancelInProgress ?? false,
    group: String(concurrency.group),
    ...(concurrency.queue === undefined ? {} : { queue: concurrency.queue }),
  });
}

export function registryFrom(definitions: readonly WorkflowDefinition[]): WorkflowContractRegistry {
  const workflows = definitions.map((definition) => {
    const base = uiContract(
      'workflow',
      definition.config.displayName ?? definition.config.name,
      'coordination',
      'automation',
      'workflow',
    );
    const concurrencyCanonical = canonicalConcurrency(definition.config.concurrency);
    return {
      ...base,
      purpose: definition.config.doc.purpose,
      path: definition.config.path,
      ...(concurrencyCanonical === undefined ? {} : { concurrencyCanonical }),
      jobs: definition.config.jobs.map(
        (job) => jobContract(job, (definition.config.requiredContexts ?? []).includes(job.id)),
      ),
    };
  });
  const required = requiredContextsFrom(definitions);
  const withoutDigest = {
    schema: 'example.workflow-contract.v2' as const,
    requiredChecks: {
      develop: required,
      main: required,
    },
    workflows,
    lanes: laneContractFrom(definitions),
  };
  return {
    ...withoutDigest,
    registryDigest: computeRegistryDigest(withoutDigest),
  } as WorkflowContractRegistry;
}

// Stable machine identities issued before typed generation. These aliases are
// identity migrations, not a second copy of runner, selection, or evidence policy.
const laneIdentityAliases: Readonly<Record<string, string>> = {
  'ios-tests.await-retained-ios-predecessor': 'ios.await-retained-predecessor',
  'ios-tests.budget-e2e': 'ios.e2e-budget',
  'ios-tests.build-ios-e2e-test-products': 'ios.e2e-build',
  'ios-tests.build-ios-native-test-products': 'ios.native-build',
  'ios-tests.chat-plaid-e2e': 'ios.e2e-chat-plaid',
  'ios-tests.confirm-current-ios-pr': 'ios.confirm-current-pr',
  'ios-tests.income-e2e': 'ios.e2e-income',
  'ios-tests.ios-change-gate': 'ios.plan',
  'ios-tests.onboarding-e2e': 'ios.e2e-onboarding',
  'ios-tests.onboarding-e2e-status': 'ios.e2e-aggregate',
  'ios-tests.prepare-dev-e2e-schema': 'ios.e2e-schema',
  'ios-tests.remove-run-artifacts-after-success': 'ios.remove-run-artifacts',
  'ios-tests.storekit-purchase-status': 'ios.storekit-aggregate',
  'ios-tests.test-ios': 'ios.native-aggregate',
  'ios-tests.test-ios-execution': 'ios.native-shards',
  'ios-tests.verify-ios-release-archive': 'ios.release-archive',
  'pr-checks.validate': 'pr.aggregate',
  'pr-checks.database-integration': 'pr.database',
  'pr-checks.ios-contracts': 'pr.ios-contracts',
  'pr-checks.lint': 'pr.lint',
  [`pr-checks.${prValidationPlanning.id}`]: 'pr.plan',
  'pr-checks.server-process-tests': 'pr.server-process',
  'pr-checks.server-tests': 'pr.server-shards',
  'pr-checks.server-static': 'pr.server-static',
  'pr-checks.targeted-server-tests': 'pr.targeted-server',
  'pr-checks.workflow-contracts': 'pr.workflow-contracts',
  'refresh-pr-ci-after-base-edit.fan-out-base-update': 'refresh.fan-out-base-update',
  'cancel-blocked-pr-ci.cancel-blocked-pr-ci': 'review.aggregate',
};

export function laneContractFrom(definitions: readonly WorkflowDefinition[]): WorkflowLaneContract[] {
  const lanes: WorkflowLaneContract[] = [];
  for (const definition of definitions) {
    const workflowSlug = definition.config.path.replace(/^\.github\/workflows\//, '').replace(/\.ya?ml$/, '');
    const required = new Set(definition.config.requiredContexts ?? []);
    for (const typed of definition.config.jobs) {
      const displayName = renderedLiterals(typed.config.name)[0] ?? '';
      const checkContext = required.has(typed.id) ? requiredCheckContextSchema.safeParse(displayName) : undefined;
      const concurrencyCanonical = canonicalConcurrency(typed.config.concurrency);
      lanes.push({
        id: laneIdentityAliases[`${workflowSlug}.${typed.id}`] ?? `${workflowSlug}.${typed.id}`,
        displayName,
        workflowPath: definition.config.path,
        jobId: typed.id,
        ...(checkContext?.success ? { checkContext: checkContext.data } : {}),
        dependencies: (typed.config.needs ?? []).map((dependency) => dependency.id),
        runnerClass: typed.config.lane.runnerClass,
        costClass: typed.config.lane.costClass,
        evidencePolicy: typed.config.lane.evidencePolicy,
        selectionOwner: typed.config.lane.selectionOwner,
        runsOnCanonical: JSON.stringify(
          typeof typed.config.runsOn === 'string' || Array.isArray(typed.config.runsOn)
            ? typed.config.runsOn
            : 'group' in typed.config.runsOn
              ? { group: typed.config.runsOn.group, labels: typed.config.runsOn.labels }
              : String(typed.config.runsOn),
        ),
        ...(concurrencyCanonical === undefined ? {} : { concurrencyCanonical }),
      });
    }
  }
  return lanes;
}

/** Deterministic compatibility snapshots, owned by the workflow definitions. */
export function contractSourcesFrom(definitions: readonly WorkflowDefinition[]): Map<string, string> {
  const workflows = definitions.map((definition) => ({
    path: definition.config.path,
    displayName: definition.config.displayName ?? definition.config.name,
    semanticCategory: 'coordination',
    failureOwner: 'automation',
    statusUnit: 'workflow',
    concurrencyCanonical: canonicalConcurrency(definition.config.concurrency),
    jobs: definition.config.jobs.map((job) => ({
      id: job.id,
      displayName: renderedLiterals(job.config.name)[0] ?? '',
      semanticCategory: job.config.category,
      failureOwner: job.config.owner,
      statusUnit: job.config.unit,
      steps: job.config.steps.map((step) => ({
        id: step.config.id ?? slug(renderedLiterals(step.config.name)[0] ?? ''),
        ...(step.config.id === undefined ? {} : { workflowStepId: step.config.id }),
        displayName: renderedLiterals(step.config.name)[0] ?? '',
        semanticCategory: step.config.category,
        failureOwner: step.config.owner,
        statusUnit: step.config.unit,
      })),
    })),
  }));
  return new Map([
    ['ci/contracts/workflow-ui-contract.v2.json', `${JSON.stringify({ schema: 'example.workflow-ui-contract.v2', workflows }, null, 2)}\n`],
    ['ci/contracts/workflow-lane-contract.v2.json', `${JSON.stringify({ schema: 'example.workflow-lane-contract.v2', lanes: laneContractFrom(definitions) }, null, 2)}\n`],
  ]);
}

export interface StepOwnerIndex {
  readonly owners: ReadonlyMap<string, FailureOwner>;
}

export function stepKey(workflowPath: string, jobLiteral: string, step: string | number): string {
  return `${workflowPath}\n${jobLiteral}\n${typeof step === 'number' ? `#${step}` : step}`;
}

/**
 * Every way GitHub can report a step, mapped to who owns its failure: each
 * literal a job name can render, crossed with the step's own name and its
 * 1-based position among the job's declared steps.
 */
export function stepOwnerIndexFrom(definitions: readonly WorkflowDefinition[]): StepOwnerIndex {
  const owners = new Map<string, FailureOwner>();
  for (const definition of definitions) {
    for (const typed of definition.config.jobs) {
      for (const jobLiteral of renderedLiterals(typed.config.name)) {
        typed.config.steps.forEach((step, index) => {
          owners.set(stepKey(definition.config.path, jobLiteral, index + 1), step.config.owner);
          for (const stepLiteral of renderedLiterals(step.config.name)) {
            owners.set(stepKey(definition.config.path, jobLiteral, stepLiteral), step.config.owner);
          }
        });
      }
    }
  }
  return { owners };
}

export interface ReportedStep {
  readonly workflowPath: string;
  readonly jobName: string;
  readonly stepName: string;
  /** 1-based position among the job's own steps, when the caller knows it. */
  readonly stepNumber?: number;
}

/**
 * A step GitHub reported, resolved to its failure owner. Anything the index
 * cannot place is product-owned: the conservative answer for an automation
 * that would otherwise update a branch or rerun a lane on its own.
 */
export function resolveStepOwner(index: StepOwnerIndex, step: ReportedStep): FailureOwner {
  for (const jobLiteral of [step.jobName, jobLiteralName(step.jobName)]) {
    const byName = index.owners.get(stepKey(step.workflowPath, jobLiteral, step.stepName));
    if (byName !== undefined) return byName;
    if (step.stepNumber !== undefined) {
      const byNumber = index.owners.get(stepKey(step.workflowPath, jobLiteral, step.stepNumber));
      if (byNumber !== undefined) return byNumber;
    }
  }
  return 'product';
}

/** The required check contexts the definitions declare, sorted and de-duplicated. */
export function requiredContextsFrom(definitions: readonly WorkflowDefinition[]): RequiredCheckContext[] {
  const contexts = new Set<RequiredCheckContext>();
  for (const definition of definitions) {
    for (const id of definition.config.requiredContexts ?? []) {
      const typed = definition.config.jobs.find((job) => job.id === id);
      if (typed === undefined) continue;
      const displayName = renderedLiterals(typed.config.name)[0] ?? '';
      const parsed = requiredCheckContextSchema.safeParse(displayName);
      if (!parsed.success) {
        throw new Error(
          `${definition.config.path}: job ${id} is declared required but "${displayName}" is not a known required check context; `
          + 'add it to requiredCheckContextSchema and update the branch ruleset in the same change',
        );
      }
      contexts.add(parsed.data);
    }
  }
  return [...contexts].sort();
}

/** Every rendered job name of a definition, for consumers that match on them. */
export function renderedJobNames(definition: WorkflowDefinition): readonly string[] {
  return definition.config.jobs.flatMap((typed) => renderedLiterals(typed.config.name));
}

/** What GitHub shows for a job, including any expression suffix. */
export function renderedJobName(typed: TypedJob): string {
  return String(renderName(typed.config.name));
}
