import { typedJob, typedStep, typedWorkflow } from './lib/index.ts';
import { PR_LANE_NODE_VERSION, saveNodeDependencySteps } from './lib/nodeModulesCache.ts';
import { hostedLinuxRunnerLabels } from '../src/runnerPolicy.ts';

/**
 * The only writer of the `node_modules` Actions cache the PR lanes restore.
 *
 * GitHub scopes a cache entry to the ref that saved it; entries saved on the
 * default branch (develop) are readable by every pull request into it, while
 * entries saved by a pull request are readable by that pull request alone.
 * Saving here, once per lockfile, gives every PR one shared entry and keeps
 * PR-built trees (and their size) out of the repository's cache quota, which
 * the iOS test-product handoff also relies on.
 *
 * The path filter lists every input of the key (`ci/src/nodeModulesCache.ts`)
 * that lives in the repository; the Node version reaches it through the
 * generated PR workflow, which changes whenever that version does.
 */
const populate = typedJob('populate', {
  name: 'Save the Node.js dependency cache',
  doc: {
    purpose: 'Installs the application tree once per lockfile and saves it for PR lanes on '
      + 'hosted runners.',
    successMeaning: 'The tree for the current develop lockfile exists in the Actions cache.',
  },
  owner: 'infrastructure',
  category: 'environment',
  unit: 'job',
  runsOn: hostedLinuxRunnerLabels,
  timeoutMinutes: 15,
  lane: {
    runnerClass: 'hosted-control',
    costClass: 'light',
    evidencePolicy: 'none',
    selectionOwner: 'controller',
  },
  steps: [
    typedStep({
      name: 'Check out develop',
      doc: {
        purpose: 'Puts the develop manifests and installers in the workspace.',
        recovery: 'retry; a repeated failure is a GitHub or runner network problem',
      },
      owner: 'infrastructure',
      category: 'environment',
      unit: 'step',
      uses: 'actions/checkout@v7.0.1',
      with: { 'persist-credentials': false, 'fetch-depth': 1 },
    }),
    typedStep({
      name: 'Set up the Node.js runtime',
      doc: {
        purpose: 'Installs the same Node version the PR lanes use, so the keys match.',
        recovery: 'check the pinned Node version is still published for this runner architecture',
      },
      owner: 'infrastructure',
      category: 'environment',
      unit: 'step',
      uses: 'actions/setup-node@v7.0.0',
      with: { 'node-version': PR_LANE_NODE_VERSION, 'package-manager-cache': false },
    }),
    ...saveNodeDependencySteps(),
  ],
});

export const nodeModulesCache = typedWorkflow({
  path: '.github/workflows/node-modules-cache.yml',
  source: 'ci/workflows/node-modules-cache.ts',
  name: 'Node.js dependency cache',
  doc: { purpose: 'Saves the exact-key node_modules tree the PR lanes restore on hosted runners.' },
  on: {
    push: {
      branches: ['develop'],
      paths: [
        'package.json',
        'package-lock.json',
        '.npmrc',
        'ci/src/nodeModulesCache.ts',
        'ci/src/actions/nodeModulesCacheKey.ts',
        'ci/src/actions/installNodeDependencies.ts',
        '.github/workflows/node-modules-cache.yml',
        '.github/workflows/pr-checks.yml',
      ],
    },
    workflow_dispatch: {},
  },
  permissions: { contents: 'read' },
  // A newer develop push carries the newer lockfile; the older save is moot.
  concurrency: { group: 'node-modules-cache', cancelInProgress: true },
  jobs: [populate],
});
