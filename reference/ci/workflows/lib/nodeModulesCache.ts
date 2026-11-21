import { expr } from './expressions.ts';
import { typedStep, type TypedStep } from './model.ts';

/**
 * The Node version the PR lanes install with. The develop cache writer uses
 * the same constant, so its entries carry the key the lanes compute.
 */
export const PR_LANE_NODE_VERSION = '26.5.0';

const CACHE_RESTORE = 'actions/cache/restore@v6.1.0';
const CACHE_SAVE = 'actions/cache/save@v6.1.0';
const RESTORE_PATH = 'node_modules';
const KEY_STEP_ID = 'node-modules-key';
const RESTORE_STEP_ID = 'node-modules-restore';
const LOOKUP_STEP_ID = 'node-modules-lookup';
const cacheKey = expr(`steps.${KEY_STEP_ID}.outputs.key`);

/**
 * Only GitHub-hosted VMs use the Actions cache. Self-hosted lanes clone the
 * tree from their runner's tool cache (`installNodeDependencies.ts`), which
 * never leaves the host.
 */
const HOSTED_RUNNER = "runner.environment == 'github-hosted'";

const withCondition = (condition: string | undefined) =>
  condition === undefined ? {} : { if: expr(condition) };

function keyStep(condition: string | undefined): TypedStep<'key'> {
  return typedStep({
    id: KEY_STEP_ID,
    outputs: ['key'] as const,
    name: 'Compute the dependency cache key',
    doc: {
      purpose: 'Empties node_modules and names the exact cache entry for this lockfile, Node, '
        + 'npm, OS and architecture.',
      recovery: 'read the error; the step fails only when npm or a manifest is missing',
    },
    owner: 'infrastructure',
    category: 'environment',
    unit: 'step',
    ...withCondition(condition),
    command: 'node ci/src/actions/nodeModulesCacheKey.ts',
  });
}

function installStep(options: {
  readonly condition: string | undefined;
  readonly cacheHitStep: string | undefined;
}): TypedStep {
  return typedStep({
    name: 'Install Node.js dependencies',
    doc: {
      purpose: 'Installs the workspace dependencies from the committed lockfile, or keeps the '
        + 'exact tree restored from the cache.',
      recovery: 'read the npm log; a lockfile conflict is fixed in the branch, a registry error '
        + 'retried',
    },
    owner: 'infrastructure',
    category: 'environment',
    unit: 'step',
    ...withCondition(options.condition),
    env: {
      // `runner.environment` is a context only; GitHub does not export it.
      RUNNER_ENVIRONMENT: expr('runner.environment'),
      ...(options.cacheHitStep === undefined ? {} : {
        NODE_MODULES_CACHE_HIT: expr(`steps.${options.cacheHitStep}.outputs.cache-hit`),
      }),
    },
    command: 'node ci/src/actions/installNodeDependencies.ts',
  });
}

/**
 * The shared install for every PR lane that needs the application tree. On
 * hosted VMs it computes the key and restores the develop-saved tree for
 * exactly that key; the installer then skips `npm ci` only for a tree this
 * job restored, stamped with this job's key and accepted by `npm ls`.
 */
export function installNodeDependencySteps(condition?: string): readonly TypedStep<string>[] {
  const hosted = condition === undefined ? HOSTED_RUNNER : `${HOSTED_RUNNER} && (${condition})`;
  return [
    keyStep(hosted),
    typedStep({
      id: RESTORE_STEP_ID,
      name: 'Restore cached Node.js dependencies',
      doc: {
        purpose: 'Downloads the node_modules tree saved on develop for exactly this key; no '
          + 'partial or neighbouring key is ever restored.',
        recovery: 'none needed; a miss or failed download falls back to npm ci',
      },
      owner: 'infrastructure',
      category: 'environment',
      unit: 'step',
      if: expr(hosted),
      uses: CACHE_RESTORE,
      with: { path: RESTORE_PATH, key: cacheKey },
    }),
    installStep({ condition, cacheHitStep: RESTORE_STEP_ID }),
  ];
}

/**
 * Develop-only writer: look the key up, and on a miss install and save. The
 * lanes never save, so every entry was built from a develop revision.
 */
export function saveNodeDependencySteps(): readonly TypedStep<string>[] {
  const miss = `steps.${LOOKUP_STEP_ID}.outputs.cache-hit != 'true'`;
  return [
    keyStep(undefined),
    typedStep({
      id: LOOKUP_STEP_ID,
      name: 'Look up the cached Node.js dependencies',
      doc: {
        purpose: 'Checks whether develop already saved this exact key, without downloading it.',
        recovery: 'none needed; a failed lookup is treated as a miss and the tree is rebuilt',
      },
      owner: 'infrastructure',
      category: 'environment',
      unit: 'step',
      uses: CACHE_RESTORE,
      with: { path: RESTORE_PATH, key: cacheKey, 'lookup-only': true },
    }),
    installStep({ condition: miss, cacheHitStep: undefined }),
    typedStep({
      name: 'Save the Node.js dependency cache',
      doc: {
        purpose: 'Publishes the stamped tree under its exact key for PR lanes on hosted runners.',
        recovery: 'rerun the workflow; lanes install with npm ci until an entry exists',
      },
      owner: 'infrastructure',
      category: 'environment',
      unit: 'step',
      if: expr(miss),
      uses: CACHE_SAVE,
      with: { path: RESTORE_PATH, key: cacheKey },
    }),
  ];
}
