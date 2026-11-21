import { initialControlAdmission } from '../lib/controlAdmission.ts';
import { ciEventCondition, expr, github, typedStep } from '../lib/index.ts';
import { STEP_ACTION_DIRECTORY } from '../lib/stepAction.ts';
import { CHECKOUT, setupNode } from './shared.ts';

export const IOS_PLANNING_CONDITION = `${ciEventCondition('ready')} && inputs.test_scope != 'observability-credential-sync'`;

/** Route Linux planning before it can wait behind other controllers; never executes a PR head. */
export const iosInitialControlRoute = initialControlAdmission({
  name: 'Route iOS planner to available Linux capacity',
  condition: expr(IOS_PLANNING_CONDITION),
  trustedSteps: [
    typedStep({
      name: 'Checkout trusted Linux admission policy',
      doc: { purpose: 'Loads the default-branch controller routing policy without PR credentials.', recovery: 'An unavailable checkout leaves the gate on its external fallback.' },
      owner: 'infrastructure', category: 'environment', unit: 'step',
      uses: CHECKOUT,
      with: {
        ref: github('event.repository.default_branch'),
        'persist-credentials': false,
        'sparse-checkout': `ci/src\nscripts/ci/generated\n${STEP_ACTION_DIRECTORY}\n`,
      },
    }),
    setupNode('Setup Node for Linux admission'),
  ],
});
