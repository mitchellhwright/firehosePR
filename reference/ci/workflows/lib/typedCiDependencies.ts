import type { ConditionLike } from 'gagen';
import { typedStep, type TypedStep } from './index.ts';

/**
 * The typed layer's own dependencies, installed where the program will be
 * loaded from: `--prefix ci` populates the workspace copy, which is the wrong
 * one for a program running out of a separate trusted checkout.
 */
export function installTypedCiDependencies(
  name: string,
  prefix: string,
  options: { readonly if?: ConditionLike } = {},
): TypedStep {
  return typedStep({
    name,
    doc: {
      purpose: 'Installs the typed CI layer dependencies where the program this job runs is loaded from.',
      recovery: 'read the npm log; a lockfile conflict is fixed in the branch, a registry error retried',
    },
    owner: 'infrastructure',
    category: 'environment',
    unit: 'step',
    ...(options.if === undefined ? {} : { if: options.if }),
    command: `npm ci --prefix ${prefix} --no-audit --no-fund --ignore-scripts`,
  });
}
