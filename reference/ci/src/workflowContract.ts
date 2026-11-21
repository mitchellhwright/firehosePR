import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';

import { z } from 'zod';

export const planVersionSchema = z.literal('example.workflow-contract.v2');
export type PlanVersion = z.infer<typeof planVersionSchema>;

export const registryDigestSchema = z.string().regex(/^[0-9a-f]{64}$/);
export type RegistryDigest = z.infer<typeof registryDigestSchema>;

export const branchClassSchema = z.enum(['develop', 'main']);
export type BranchClass = z.infer<typeof branchClassSchema>;

export const runnerClassSchema = z.enum([
  'hosted-control',
  'linux-external-preferred',
  'linux-hosted-overflow',
  'linux-self-hosted',
  'self-hosted-dynamic',
  'macos-physical',
]);
export type RunnerClass = z.infer<typeof runnerClassSchema>;

export const costClassSchema = z.enum(['control', 'light', 'medium', 'expensive']);
export type CostClass = z.infer<typeof costClassSchema>;

export const evidencePolicySchema = z.enum([
  'none',
  'exact-head',
  'patch-equivalent',
]);
export type EvidencePolicy = z.infer<typeof evidencePolicySchema>;

export const selectionOwnerSchema = z.enum([
  'always',
  'typed-pr-validation',
  'typed-ios-native',
  'legacy-ios-selector',
  'controller',
]);
export type SelectionOwner = z.infer<typeof selectionOwnerSchema>;

export const requiredCheckContextSchema = z.enum([
  'Lint changed code',
  'Validate pull request changes',
  'Test - iOS',
  'Onboarding E2E',
  'iOS Change Gate',
  'StoreKit Purchase - iOS',
]);
export type RequiredCheckContext = z.infer<typeof requiredCheckContextSchema>;

const genericUiNames = new Set([
  'checkout',
  'controller',
  'database-integration',
  'install dependencies',
  'lint',
  'run',
  'setup node',
  'pr checks',
  'test - ios',
  'type check',
  'validation policy',
  'validate',
]);

function readableName(options: { readonly allowGenericName: boolean }): z.ZodType<string> {
  return z.string().trim().min(3).max(100).superRefine((name, context) => {
    if (name.includes('${{')) {
      context.addIssue({ code: 'custom', message: 'UI names cannot contain GitHub expressions' });
    }
    if (!options.allowGenericName && genericUiNames.has(name.toLowerCase())) {
      context.addIssue({ code: 'custom', message: `UI name is too generic: ${name}` });
    }
    if (/\.(?:sh|mjs|cjs|js|ts|tsx|swift|ya?ml|json)\b/i.test(name)
        && !/\bnode\.js\b/i.test(name)) {
      context.addIssue({ code: 'custom', message: `UI name exposes a source filename: ${name}` });
    }
  });
}

export const humanReadableNameSchema = readableName({ allowGenericName: false });

/**
 * The same rule with the generic-name clause lifted, for a name a branch
 * ruleset already lists. "Test - iOS" is both a generic name and the context
 * develop and main require of the iOS aggregate: renaming it stops the gate
 * rather than reading better, so that one job publishes it as it is.
 *
 * This is not a way to opt a name out of the rule. It applies only where the
 * caller has established that the workflow declares this job required under
 * exactly this name — `typedWorkflow` refuses the declaration otherwise — so
 * a future job cannot be called "Test - iOS" just because it parses.
 */
export const requiredContextNameSchema = readableName({ allowGenericName: true });

export const failureOwnerSchema = z.enum([
  'automation', 'product', 'security', 'iam', 'review', 'infrastructure',
]);

const progressCodeSchema = z.enum(['queued', 'running', 'retrying', 'completed']);
export const statusUnitSchema = z.enum([
  'workflow', 'job', 'step', 'shard', 'suite', 'artifact', 'runner-lease', 'dependency',
]);

const uiContractSchema = z.object({
  displayName: humanReadableNameSchema,
  purpose: z.string().min(10).max(240),
  progressVocabulary: z.array(progressCodeSchema).min(3),
  statusDetail: z.object({
    unit: statusUnitSchema,
    running: z.string().min(10).max(240),
    nextUpdateSeconds: z.number().int().min(1).max(300),
  }).strict(),
  successMeaning: z.string().min(10).max(240),
  failureOwner: failureOwnerSchema,
  nextAction: z.string().min(10).max(240),
}).strict();

type UiSemanticCategory = 'quality' | 'artifact' | 'environment' | 'cleanup' | 'evidence' | 'planning' | 'release' | 'coordination';

export const uiSemanticCategorySchema = z.enum([
  'quality', 'artifact', 'environment', 'cleanup', 'evidence', 'planning', 'release', 'coordination',
]);

const compactStepSchema = z.object({
  id: z.string().regex(/^[a-z0-9][a-z0-9-]*$/),
  workflowStepId: z.string().min(1).optional(),
  displayName: humanReadableNameSchema,
  semanticCategory: uiSemanticCategorySchema,
  failureOwner: failureOwnerSchema,
  statusUnit: statusUnitSchema,
}).strict();

const compactJobSchema = z.object({
  id: z.string().min(1),
  // A job that IS a required check context may carry a name the readability
  // rule rejects — `Test - iOS` is generic by every measure and cannot be
  // renamed, because branch protection on develop and main both name it.
  // `requiredCheckContextSchema` is the closed list of those names, so this
  // stays narrow: any other generic name is still refused.
  displayName: z.union([humanReadableNameSchema, requiredCheckContextSchema]),
  semanticCategory: uiSemanticCategorySchema,
  failureOwner: failureOwnerSchema,
  statusUnit: statusUnitSchema,
  steps: z.array(compactStepSchema),
}).strict();

const compactWorkflowSchema = z.object({
  path: z.string().regex(/^\.github\/workflows\/[^/]+\.ya?ml$/),
  displayName: humanReadableNameSchema,
  semanticCategory: uiSemanticCategorySchema,
  failureOwner: failureOwnerSchema,
  statusUnit: statusUnitSchema,
  concurrencyCanonical: z.string().min(1).optional(),
  jobs: z.array(compactJobSchema),
}).strict();

const compactUiRegistrySchema = z.object({
  schema: z.literal('example.workflow-ui-contract.v2'),
  workflows: z.array(compactWorkflowSchema),
}).strict();

const semanticText: Record<UiSemanticCategory, { action: string; result: string; recovery: string }> = {
  quality: {
    action: 'Evaluate the declared quality or safety condition for', result: 'passed its declared checks and produced attributable evidence', recovery: 'inspect its failed assertion, correct the owning source, and rerun this check',
  },
  artifact: {
    action: 'Produce the versioned artifact required by', result: 'produced its artifact for the declared downstream consumer', recovery: 'inspect its build diagnostics, correct the source or environment, and rebuild it',
  },
  environment: {
    action: 'Prepare and verify the execution capabilities needed by', result: 'made its required execution capabilities available', recovery: 'inspect its capability diagnostics, restore the missing requirement, and retry setup',
  },
  cleanup: {
    action: 'Remove only the bounded disposable resources identified by', result: 'removed its disposable resources while preserving active work', recovery: 'inspect its cleanup inventory, correct ownership or lifecycle state, and retry safely',
  },
  evidence: {
    action: 'Persist attributable evidence produced by', result: 'stored its complete evidence at the declared traceable destination', recovery: 'inspect its source and destination records, restore missing evidence, and repeat the transfer',
  },
  planning: {
    action: 'Determine the bounded work, dependencies, and capabilities for', result: 'produced its complete deterministic execution plan', recovery: 'inspect its inputs and reason codes, correct the invalid input, and recompute it',
  },
  release: {
    action: 'Advance the verified artifact through', result: 'reached its release checkpoint with required evidence intact', recovery: 'inspect its checkpoint evidence and deployment diagnostics, correct the failure, and resume',
  },
  coordination: {
    action: 'Coordinate the bounded state transition performed by', result: 'completed its transition and supplied consistent state downstream', recovery: 'inspect its transition reason and dependencies, repair the blocked state, and reconcile again',
  },
};

/**
 * The UI vocabulary every surface shares, derived from its semantic category
 * so two surfaces of the same kind always describe themselves the same way.
 * `ci/workflows/lib/projections.ts` builds on this and replaces the derived
 * purpose and next action with the definition's own sentences where it has
 * more specific ones.
 */
export function uiContract(
  kind: 'workflow' | 'job' | 'step',
  displayName: string,
  category: UiSemanticCategory,
  failureOwner: z.infer<typeof failureOwnerSchema>,
  unit: z.infer<typeof statusUnitSchema>,
  /**
   * Set only for a job whose rendered name is a required check context of its
   * own workflow. `Test - iOS` is generic by every readability rule and cannot
   * be renamed: branch protection on develop and main both name it. The
   * exemption is deliberately not "the name parses as a context" — that is a
   * shape test plenty of genuinely generic names would pass. The caller has to
   * know the workflow requires this job.
   */
  isRequiredContext = false,
) {
  const semantics = semanticText[category];
  return (isRequiredContext ? requiredContextUiSchema : uiContractSchema).parse({
    displayName,
    purpose: `${semantics.action} ${displayName}.`,
    progressVocabulary: ['queued', 'running', 'retrying', 'completed'],
    statusDetail: {
      unit,
      running: `${displayName} is ${category === 'planning' ? 'computing its deterministic plan' : category === 'quality' ? 'evaluating its declared conditions' : category === 'artifact' ? 'producing its required artifact' : category === 'environment' ? 'preparing required capabilities' : category === 'cleanup' ? 'removing bounded disposable resources' : category === 'evidence' ? 'persisting attributable evidence' : category === 'release' ? 'advancing through its release checkpoint' : 'reconciling its bounded transition'}.`,
      nextUpdateSeconds: kind === 'step' ? 60 : 300,
    },
    successMeaning: `${displayName} ${semantics.result}.`,
    failureOwner,
    nextAction: `${failureOwner[0]?.toUpperCase()}${failureOwner.slice(1)} owner: for ${displayName}, ${semantics.recovery}.`,
  });
}

export const workflowStepContractSchema = uiContractSchema.extend({
  id: compactStepSchema.shape.id,
  workflowStepId: compactStepSchema.shape.workflowStepId,
  // Derived from array order when the registry is loaded, never written by
  // hand: a hand-numbered position turned every step insertion into a
  // renumbering of everything after it, which made any two PRs touching the
  // same job conflict.
  position: z.number().int().positive(),
}).strict();

export const workflowJobUiContractSchema = uiContractSchema.extend({
  // Same narrow exemption as the compact form: a job whose name is one of the
  // closed set of required check contexts keeps it, because branch protection
  // names it and the job cannot be renamed without editing the ruleset.
  displayName: z.union([humanReadableNameSchema, requiredCheckContextSchema]),
  id: z.string().min(1),
  steps: z.array(workflowStepContractSchema),
}).strict();

export const workflowUiContractSchema = uiContractSchema.extend({
  path: compactWorkflowSchema.shape.path,
  concurrencyCanonical: compactWorkflowSchema.shape.concurrencyCanonical,
  jobs: z.array(workflowJobUiContractSchema),
}).strict();

export const workflowLaneContractSchema = z.object({
  id: z.string().min(1),
  displayName: z.string().min(1).max(80).refine((name) => !name.includes('${{')),
  workflowPath: z.string().regex(/^\.github\/workflows\/[^/]+\.ya?ml$/),
  jobId: z.string().regex(/^[a-z0-9-]+$/),
  checkContext: requiredCheckContextSchema.optional(),
  dependencies: z.array(z.string().min(1)),
  runnerClass: runnerClassSchema,
  costClass: costClassSchema,
  evidencePolicy: evidencePolicySchema,
  selectionOwner: selectionOwnerSchema,
  runsOnCanonical: z.string().min(1),
  concurrencyCanonical: z.string().min(1).optional(),
}).strict();
export type WorkflowLaneContract = z.infer<typeof workflowLaneContractSchema>;

export const workflowContractRegistrySchema = z.object({
  schema: planVersionSchema,
  registryDigest: registryDigestSchema,
  requiredChecks: z.object({
    develop: z.array(requiredCheckContextSchema),
    main: z.array(requiredCheckContextSchema),
  }).strict(),
  workflows: z.array(workflowUiContractSchema),
  lanes: z.array(workflowLaneContractSchema),
}).strict().superRefine((registry, context) => {
  const { registryDigest, ...unpinnedRegistry } = registry;
  if (computeRegistryDigest(unpinnedRegistry) !== registryDigest) {
    context.addIssue({
      code: 'custom', message: 'Registry digest does not match canonical registry content',
      path: ['registryDigest'],
    });
  }
  const workflowPaths = registry.workflows.map((workflow) => workflow.path);
  if (new Set(workflowPaths).size !== workflowPaths.length) {
    context.addIssue({ code: 'custom', message: 'Workflow paths must be unique', path: ['workflows'] });
  }
  const requiredContextNames = new Set([
    ...registry.requiredChecks.develop,
    ...registry.requiredChecks.main,
  ]);
  const jobs = new Map<string, z.infer<typeof workflowJobUiContractSchema>>();
  for (const [workflowIndex, workflow] of registry.workflows.entries()) {
    const jobIds = workflow.jobs.map((job) => job.id);
    if (new Set(jobIds).size !== jobIds.length) {
      context.addIssue({
        code: 'custom', message: 'Job IDs must be unique within a workflow',
        path: ['workflows', workflowIndex, 'jobs'],
      });
    }
    for (const [jobIndex, job] of workflow.jobs.entries()) {
      jobs.set(`${workflow.path}:${job.id}`, job);
      // The compact JSON has to admit a required context whose spelling is
      // intentionally generic (currently `Test - iOS`) before the lane
      // registry is loaded. Bind that exemption here, once both halves are
      // available: the matching lane must publish the same context and branch
      // protection must actually require it. Merely spelling a known context
      // is not enough to bypass the human-readable-name rule.
      if (!humanReadableNameSchema.safeParse(job.displayName).success) {
        const lane = registry.lanes.find((candidate) => (
          candidate.workflowPath === workflow.path && candidate.jobId === job.id
        ));
        if (lane?.checkContext !== job.displayName
            || !requiredContextNames.has(job.displayName as RequiredCheckContext)) {
          context.addIssue({
            code: 'custom',
            message: 'A generic job name is allowed only when its lane publishes '
              + 'that required check context',
            path: ['workflows', workflowIndex, 'jobs', jobIndex, 'displayName'],
          });
        }
      }
      const stepIds = job.steps.map((step) => step.id);
      const stepNames = job.steps.map((step) => step.displayName.toLowerCase());
      if (new Set(stepIds).size !== stepIds.length || new Set(stepNames).size !== stepNames.length) {
        context.addIssue({
          code: 'custom', message: 'Step IDs and visible names must be unique within a job',
          path: ['workflows', workflowIndex, 'jobs', jobIndex, 'steps'],
        });
      }
    }
  }
  const laneJobKeys = registry.lanes.map((lane) => `${lane.workflowPath}:${lane.jobId}`);
  if (new Set(laneJobKeys).size !== laneJobKeys.length) {
    context.addIssue({
      code: 'custom',
      message: 'Each workflow job must map to exactly one typed lane',
      path: ['lanes'],
    });
  }
  for (const [laneIndex, lane] of registry.lanes.entries()) {
    const job = jobs.get(`${lane.workflowPath}:${lane.jobId}`);
    if (!job) {
      context.addIssue({
        code: 'custom', message: 'Lane must reference a declared workflow job',
        path: ['lanes', laneIndex],
      });
    } else if (job.displayName !== lane.displayName) {
      context.addIssue({
        code: 'custom', message: 'Lane display name must match its canonical job display name',
        path: ['lanes', laneIndex, 'displayName'],
      });
    }
  }
});

/**
 * `uiContractSchema` with only the generic-name clause lifted. Derived from it
 * rather than restated, so a field added there cannot go missing here.
 */
const requiredContextUiSchema = uiContractSchema.extend({ displayName: requiredContextNameSchema });

export type WorkflowContractRegistry = z.infer<typeof workflowContractRegistrySchema>;

const compactUiRegistry = compactUiRegistrySchema.parse(JSON.parse(readFileSync(
  new URL('../contracts/workflow-ui-contract.v2.json', import.meta.url),
  'utf8',
)));

const compactLaneRegistry = z.object({
  schema: z.literal('example.workflow-lane-contract.v2'),
  lanes: z.array(workflowLaneContractSchema),
}).strict().parse(JSON.parse(readFileSync(
  new URL('../contracts/workflow-lane-contract.v2.json', import.meta.url),
  'utf8',
)));

const workflows = compactUiRegistry.workflows.map((workflow) => ({
  path: workflow.path,
  concurrencyCanonical: workflow.concurrencyCanonical,
  ...uiContract('workflow', workflow.displayName, workflow.semanticCategory, workflow.failureOwner, workflow.statusUnit),
  jobs: workflow.jobs.map((job) => ({
    id: job.id,
    // A job whose name is one of the closed set of required check contexts
    // keeps that name; branch protection owns it, not the readability rule.
    ...uiContract(
      'job', job.displayName, job.semanticCategory, job.failureOwner, job.statusUnit,
      requiredCheckContextSchema.safeParse(job.displayName).success,
    ),
    steps: job.steps.map((step, index) => ({
      id: step.id,
      workflowStepId: step.workflowStepId,
      position: index + 1,
      ...uiContract('step', step.displayName, step.semanticCategory, step.failureOwner, step.statusUnit),
    })),
  })),
}));

const rawWorkflowContractRegistryWithoutDigest = {
  schema: 'example.workflow-contract.v2',
  requiredChecks: {
    develop: [
      'Lint changed code',
      'Validate pull request changes',
      'Test - iOS',
      'Onboarding E2E',
      'iOS Change Gate',
      'StoreKit Purchase - iOS',
    ],
    main: [
      'Lint changed code',
      'Validate pull request changes',
      'Test - iOS',
      'Onboarding E2E',
      'iOS Change Gate',
      'StoreKit Purchase - iOS',
    ],
  },
  workflows,
  lanes: compactLaneRegistry.lanes,
} satisfies Omit<z.input<typeof workflowContractRegistrySchema>, 'registryDigest'>;

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    return `{${Object.entries(value)
      .filter(([, entry]) => entry !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry)}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

export function computeRegistryDigest(
  registry: unknown,
): RegistryDigest {
  return registryDigestSchema.parse(
    createHash('sha256').update(canonicalJson(registry)).digest('hex'),
  );
}

const normalizedWorkflowContractRegistryWithoutDigest = {
  ...rawWorkflowContractRegistryWithoutDigest,
  workflows: z.array(workflowUiContractSchema).parse(
    rawWorkflowContractRegistryWithoutDigest.workflows,
  ),
  lanes: z.array(workflowLaneContractSchema).parse(rawWorkflowContractRegistryWithoutDigest.lanes),
};

export const workflowContractRegistry: WorkflowContractRegistry = workflowContractRegistrySchema.parse(
  {
    ...normalizedWorkflowContractRegistryWithoutDigest,
    registryDigest: computeRegistryDigest(normalizedWorkflowContractRegistryWithoutDigest),
  },
);

export function requiredChecksFor(branch: BranchClass): readonly RequiredCheckContext[] {
  return workflowContractRegistry.requiredChecks[branch];
}
