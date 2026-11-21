import { github, typedJob, typedStep, typedWorkflow } from './lib/index.ts';

const githubApi = {
  GITHUB_API_URL: github('api_url'),
  GITHUB_REPOSITORY: github('repository'),
  GITHUB_TOKEN: github('token'),
};

/**
 * Actions storage is a shared quota: once it fills, every upload in every
 * workflow starts failing, which looks like a hundred unrelated test
 * failures. GitHub expires artifacts from their retention settings; this job
 * keeps only the newest debt-card XCTest cache, four times a day.
 */
export const actionsArtifactCleanup = typedWorkflow({
  path: '.github/workflows/actions-artifact-cleanup.yml',
  source: 'ci/workflows/actions-artifact-cleanup.ts',
  name: 'Actions Artifact Cleanup',
  doc: { purpose: 'Keeps Actions storage below its quota by pruning superseded XCTest caches.' },
  on: { schedule: [{ cron: '17 */6 * * *' }], workflow_dispatch: {} },
  permissions: { actions: 'write', contents: 'read' },
  // Deletions are not idempotent against each other: two cleanups at once
  // would race on the same ids, so they queue.
  concurrency: { group: 'actions-storage-cleanup', cancelInProgress: false },
  jobs: [
    typedJob('prune-superseded-caches', {
      name: 'Prune superseded XCTest caches',
      doc: {
        purpose: 'Removes superseded debt-card XCTest caches from Actions storage.',
        successMeaning: 'The newest debt-card XCTest cache remains available.',
      },
      owner: 'infrastructure',
      category: 'cleanup',
      unit: 'job',
      runsOn: ['self-hosted', 'Linux', 'example-trusted-control'],
      timeoutMinutes: 10,
      lane: {
        runnerClass: 'linux-self-hosted',
        costClass: 'light',
        evidencePolicy: 'none',
        selectionOwner: 'controller',
      },
      steps: [
        typedStep({
          name: 'Check out the cleanup scripts',
          doc: {
            purpose: 'Puts the scripts this job runs in the workspace; without it they are absent or stale.',
            recovery: 'retry; a repeated failure is a GitHub or runner network problem',
          },
          owner: 'infrastructure',
          category: 'environment',
          unit: 'step',
          uses: 'actions/checkout@v7.0.1',
          with: { 'persist-credentials': false, 'fetch-depth': 1 },
        }),
        typedStep({
          name: 'Prune superseded debt-card XCTest caches',
          doc: {
            purpose: 'Keeps only the newest debt-card XCTest cache; GitHub handles artifact expiry.',
            recovery: 'read the HTTP status; a 403 means the job token lost actions: write',
          },
          owner: 'infrastructure',
          category: 'cleanup',
          unit: 'step',
          command: 'node ci/src/actions/cleanupActionsStorage.ts',
          env: { CACHE_KEY_PREFIX: 'ios-debt-card-test-products-v1-', ...githubApi },
        }),
      ],
    }),
  ],
});
