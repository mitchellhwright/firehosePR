import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { dump } from 'js-yaml';
import { ModuleKind, ScriptTarget, transpileModule } from 'typescript';

import {
  STEP_ACTION_DIRECTORY, STEP_ACTION_ENTRY_INPUT, STEP_ACTION_SCRIPT_INPUT,
} from './stepActionContract.ts';

export { STEP_ACTION_DIRECTORY } from './stepActionContract.ts';

const sourcePath = 'ci/src/actions/runWorkflowStep.ts';
const actionPath = STEP_ACTION_DIRECTORY;

interface ActionInput {
  readonly description: string;
  readonly required: false;
}

interface JavaScriptActionMetadata {
  readonly name: string;
  readonly description: string;
  readonly inputs: Readonly<{ script: ActionInput; entry: ActionInput }>;
  readonly runs: Readonly<{ using: 'node24'; main: 'bundle/index.cjs' }>;
}

const metadata = {
  name: 'Run a typed Example CI step',
  description: 'Run one checked-out TypeScript entrypoint or legacy CI script and report its owner and recovery action.',
  inputs: {
    [STEP_ACTION_SCRIPT_INPUT]: {
      description: 'Repository-relative script under scripts/.',
      required: false,
    },
    [STEP_ACTION_ENTRY_INPUT]: {
      description: 'Repository-relative typechecked entrypoint under ci/src/actions/.',
      required: false,
    },
  },
  runs: { using: 'node24', main: 'bundle/index.cjs' },
} as const satisfies JavaScriptActionMetadata;

/** Deterministic platform artifacts; neither output is maintained by hand. */
export function stepActionSources(root = process.cwd()): ReadonlyMap<string, string> {
  const source = readFileSync(join(root, sourcePath), 'utf8');
  const executable = transpileModule(source, {
    fileName: sourcePath,
    compilerOptions: { module: ModuleKind.CommonJS, target: ScriptTarget.ES2022 },
    reportDiagnostics: true,
  });
  if (executable.diagnostics?.length) {
    throw new Error(`Cannot emit ${sourcePath}: ${executable.diagnostics.map((item) => item.messageText).join('; ')}`);
  }
  return new Map([
    [`${actionPath}/action.yml`,
      `# GENERATED from ci/workflows/lib/stepAction.ts — edit the TypeScript source.\n${dump(metadata, { noRefs: true, lineWidth: -1 })}`],
    [`${actionPath}/bundle/index.cjs`,
      `// GENERATED from ${sourcePath} — edit the TypeScript source.\n${executable.outputText}`],
  ]);
}
