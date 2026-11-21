/**
 * How a generated workflow step names the typed step action and its one input.
 *
 * Package-free on purpose: the static workflow contracts under `ci/src/`
 * resolve what a step runs without loading the TypeScript compiler that
 * `stepAction.ts` needs to emit the action bundle.
 */

export const STEP_ACTION_DIRECTORY = '.github/actions/typed-step-runner' as const;
export const STEP_ACTION_REFERENCE = `./${STEP_ACTION_DIRECTORY}` as const;
export const STEP_ACTION_SCRIPT_INPUT = 'script' as const;
export const STEP_ACTION_ENTRY_INPUT = 'entry' as const;

export function isStepActionScriptPath(value: unknown): value is `scripts/${string}` {
  return typeof value === 'string' && /^scripts\/[a-zA-Z0-9_./-]+\.sh$/.test(value)
    && !value.split('/').includes('..');
}

export function isStepActionEntryPath(value: unknown): value is `ci/src/actions/${string}.ts` {
  return typeof value === 'string' && /^ci\/src\/actions\/[a-zA-Z0-9_./-]+\.ts$/.test(value)
    && !value.split('/').includes('..');
}
