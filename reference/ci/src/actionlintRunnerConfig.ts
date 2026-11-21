import type { WorkflowDefinition } from '../workflows/lib/model.ts';
import { mergeQueueMacLabels, reservedMacLabels, sharedMacLabels } from './ios/iosRunnerCapabilities.ts';
import {
  hostedLinuxRunnerLabels,
  supportedPrLinuxRoutePairs,
  trustedControlLinuxRunnerLabels,
} from './runnerPolicy.ts';

const supportedRoutes = [
  hostedLinuxRunnerLabels,
  trustedControlLinuxRunnerLabels,
  ...supportedPrLinuxRoutePairs.flatMap(({ portable, database }) => [portable, database]),
] as const;

/** Keep actionlint's custom runner labels in sync with typed workflow routes. */
export function renderActionlintRunnerConfig(definitions: readonly WorkflowDefinition[]): string {
  const labels = new Set<string>();
  for (const route of supportedRoutes) {
    for (const label of route) labels.add(label);
  }
  for (const route of [sharedMacLabels, reservedMacLabels, mergeQueueMacLabels]) {
    for (const label of route) labels.add(label);
  }
  for (const definition of definitions) {
    for (const job of definition.config.jobs) {
      const route = job.config.runsOn;
      const routeLabels = Array.isArray(route)
        ? route
        : typeof route === 'object' && route !== null && 'labels' in route
          ? route.labels
          : [];
      if (!Array.isArray(routeLabels)) continue;
      for (const label of routeLabels) {
        if (typeof label === 'string' && !label.startsWith('${{')) labels.add(label);
      }
    }
  }

  return [
    '# Generated from typed CI workflow runner routes. Run npm run ci:workflows to update.',
    'self-hosted-runner:',
    '  labels:',
    ...[...labels].sort().map((label) => `    - ${label}`),
    '',
  ].join('\n');
}
