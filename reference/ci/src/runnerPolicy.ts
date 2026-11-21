/**
 * Maintained runner capabilities for the repository's typed CI control plane.
 *
 * Workflow generation, runtime selection, heartbeats, and contract tests import
 * these values instead of repeating label arrays. GitHub YAML remains a
 * generated platform artifact; repository variables may select only one of the
 * typed routes declared here.
 */

export const hostedLinuxRunnerLabels = ['ubuntu-24.04'] as const;

export const trustedControlLinuxRunnerLabels = [
  'self-hosted',
  'Linux',
  'example-trusted-control',
] as const;

export const sharedControlLinuxRunnerLabels = [
  ...trustedControlLinuxRunnerLabels,
  'example-lane',
] as const;

export const sharedPortableLinuxRunnerLabels = [
  'self-hosted',
  'Linux',
  'example-lane',
  'linux-remote',
] as const;

export const sharedDatabaseLinuxRunnerLabels = [
  'self-hosted',
  'Linux',
  'example-lane',
  'ARM64',
  'docker-capable',
  'linux-remote',
] as const;

export const dedicatedPortableLinuxRunnerLabels = [
  'self-hosted',
  'Linux',
  'example-lane',
  'example-portable',
  'linux-remote',
] as const;

export const dedicatedDatabaseLinuxRunnerLabels = [
  'self-hosted',
  'Linux',
  'example-lane',
  'example-database',
  'docker-capable',
  'linux-remote',
] as const;

export const externalLinuxLaneMarker = ['self-hosted', 'Linux', 'example-lane'] as const;

export const supportedPrLinuxRoutePairs = [
  {
    kind: 'shared',
    portable: sharedPortableLinuxRunnerLabels,
    database: sharedDatabaseLinuxRunnerLabels,
  },
  {
    kind: 'dedicated',
    portable: dedicatedPortableLinuxRunnerLabels,
    database: dedicatedDatabaseLinuxRunnerLabels,
  },
] as const;

export type PrLinuxRouteKind = typeof supportedPrLinuxRoutePairs[number]['kind'];

/**
 * Timeout minutes of each PR Checks lane that may leave external Linux for
 * hosted overflow. `pr-checks.ts` sets each lane's timeout from this table.
 */
export const prHostedLinuxLaneTimeoutMinutes = {
  lint: 10,
  workflowContracts: 10,
  serverStatic: 10,
  serverProcessTests: 10,
  serverTestShard: 15,
  targetedServerTests: 10,
  iosContracts: 10,
  databaseIntegration: 20,
} as const;
