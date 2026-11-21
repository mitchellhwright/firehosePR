import {
  github, trustedControlLinuxRunner, typedJob, typedNodeActionStep, typedStep, typedWorkflow,
} from './lib/index.ts';
import { maintenanceNode } from './lib/maintenanceNode.ts';

/**
 * Plaid LinkKit is vendored as a SwiftPM binaryTarget, whose URL Dependabot
 * cannot update. Every Monday morning (ET) this job compares the pinned
 * release with Plaid's latest one and keeps a single tracking issue open while
 * the app is behind, closing it once the pin catches up.
 */
export const vendoredLinkKitVersionCheck = typedWorkflow({
  path: '.github/workflows/vendored-linkkit-version-check.yml',
  source: 'ci/workflows/vendored-linkkit-version-check.ts',
  name: 'Vendored LinkKit version check',
  doc: { purpose: "Opens or closes the tracking issue for the vendored LinkKit falling behind Plaid's latest release." },
  on: { schedule: [{ cron: '23 13 * * 1' }], workflow_dispatch: {} },
  permissions: { contents: 'read', issues: 'write' },
  // Two runs at once could both find no issue and open two, so they queue.
  concurrency: { group: 'vendored-linkkit-version-check', cancelInProgress: false },
  jobs: [
    typedJob('check', {
      name: 'Compare vendored LinkKit with the latest release',
      doc: {
        purpose: "Reads the pinned LinkKit version and Plaid's latest release, then reconciles the tracking issue.",
        successMeaning: 'The tracking issue is open exactly when the pinned LinkKit is behind the latest stable release.',
      },
      owner: 'infrastructure',
      category: 'quality',
      unit: 'job',
      runsOn: trustedControlLinuxRunner,
      timeoutMinutes: 10,
      lane: {
        runnerClass: 'linux-self-hosted',
        costClass: 'light',
        evidencePolicy: 'none',
        selectionOwner: 'controller',
      },
      steps: [
        typedStep({
          name: 'Check out the default branch',
          doc: {
            purpose: 'Reads the Package.swift that develop ships, whichever ref started the run.',
            recovery: 'retry; a repeated failure is a GitHub or runner network problem',
          },
          owner: 'infrastructure',
          category: 'environment',
          unit: 'step',
          uses: 'actions/checkout@v7.0.1',
          with: { ref: github('event.repository.default_branch'), 'persist-credentials': false, 'fetch-depth': 1 },
        }),
        maintenanceNode,
        typedNodeActionStep({
          name: 'Install typed check dependencies',
          doc: {
            purpose: 'Installs the pinned dependencies the LinkKit check imports.',
            recovery: 're-run once; then check the npm registry and the committed ci/package-lock.json',
          },
          owner: 'infrastructure',
          category: 'environment',
          unit: 'step',
          entry: 'ci/src/actions/installCiPackageDependencies.ts',
        }),
        typedNodeActionStep({
          name: 'Reconcile the LinkKit tracking issue',
          doc: {
            purpose: 'Opens, refreshes or closes the tracking issue from the pinned and latest LinkKit versions.',
            recovery: 'a parse error means Package.swift changed shape: update ci/src/vendoredLinkKit.ts; '
              + 'an HTTP 403 means the job token lost issues: write',
          },
          owner: 'infrastructure',
          category: 'quality',
          unit: 'step',
          entry: 'ci/src/actions/checkVendoredLinkKit.ts',
          env: {
            GITHUB_API_URL: github('api_url'),
            GITHUB_REPOSITORY: github('repository'),
            GITHUB_TOKEN: github('token'),
          },
        }),
      ],
    }),
  ],
});
