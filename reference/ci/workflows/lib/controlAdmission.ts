import { ciEventCondition } from './ciEvent.ts';
import { expr, github, runner, type ExpressionValue } from './expressions.ts';
import { typedJob, typedStep, type TypedStep } from './model.ts';
import { initialControlAdmissionRunner } from './runners.ts';

/** GitHub cannot move an allocated job to another pool: admit before allocating control work. */
export function initialControlAdmission(options: {
  readonly name: string;
  readonly condition?: ExpressionValue;
  readonly trustedSteps: readonly TypedStep<string>[];
  /** True only for code whose execution source the workflow already trusts. */
  readonly sameRepositoryCode?: string;
}) {
  const sameRepository = options.sameRepositoryCode ?? ciEventCondition('sameRepositoryCode');
  const script = 'ci/src/actions/selectControlRunners.ts';
  const route = typedStep({
    id: 'control-route',
    name: 'Route control jobs to free external Linux or hosted overflow',
    doc: {
      purpose: 'Chooses external Linux for the policy and verdict jobs, or hosted Linux while external has a backlog.',
      recovery: 'read the route and reason it prints; an empty output keeps the external route',
    },
    owner: 'automation', category: 'planning', unit: 'step',
    if: expr(`hashFiles('${script}') != ''`), continueOnError: true,
    outputs: ['control_runner_labels'] as const,
    env: {
      GITHUB_TOKEN: github('token'), RUNNER_ENVIRONMENT: runner('environment'),
      SAME_REPOSITORY_CODE: expr(sameRepository),
      REPOSITORY_DEFAULT_BRANCH: github('event.repository.default_branch'),
      CI_HOSTED_LINUX_AVAILABLE: expr("vars.CI_HOSTED_LINUX_AVAILABLE || '0'"),
    },
    command: `node ${script}`,
  });
  return typedJob('route-initial-control', {
    name: options.name,
    doc: {
      purpose: 'Checks trusted controller pressure before placing planning or continuity work.',
      successMeaning: 'Dependent control work has an external or admitted hosted route.',
    },
    owner: 'automation', category: 'planning', unit: 'job',
    ...(options.condition === undefined ? {} : { if: options.condition }),
    permissions: { actions: 'read', contents: 'read' },
    runsOn: initialControlAdmissionRunner(sameRepository), timeoutMinutes: 5,
    lane: { runnerClass: 'hosted-control', costClass: 'control', evidencePolicy: 'none', selectionOwner: 'controller' },
    outputs: { control_runner_labels: route.outputs.control_runner_labels },
    steps: [...options.trustedSteps, route],
  });
}
