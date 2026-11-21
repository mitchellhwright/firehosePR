import { typedStep } from './model.ts';

/** Maintenance must not depend on the listener's persistent Node installation. */
export const maintenanceNode = typedStep({
  name: 'Set up Node for typed maintenance',
  doc: {
    purpose: 'Selects a Node runtime that executes the shared TypeScript maintenance programs.',
    recovery: 'check the runner tool cache or Node download connectivity',
  },
  owner: 'infrastructure',
  category: 'environment',
  unit: 'step',
  uses: 'actions/setup-node@v7.0.0',
  with: { 'node-version': '26.5.0', 'package-manager-cache': false },
});
