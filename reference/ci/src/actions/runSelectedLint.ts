import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { parsePrLintPlan, type PrLintPlan } from '../prLintPlan.ts';

export function runSelectedLint(plan: PrLintPlan): number {
  if (plan.mode === 'none') {
    process.stdout.write('No lintable PR files changed; lint is satisfied without dependency installation.\n');
    return 0;
  }
  const command = plan.mode === 'full' ? 'npm' : 'node_modules/.bin/eslint';
  const arguments_ = plan.mode === 'full'
    ? ['run', 'lint']
    : ['--no-warn-ignored', '--report-unused-disable-directives', '--max-warnings', '0', '--', ...plan.paths];
  if (plan.mode === 'selected') {
    for (const path of plan.paths) {
      if (!existsSync(path)) throw new Error(`Selected lint file is missing from the PR checkout: ${path}`);
    }
  }
  process.stdout.write(`Lint plan: ${plan.mode}${plan.mode === 'selected' ? ` (${plan.paths.length} files)` : ''}.\n`);
  const result = spawnSync(command, arguments_, { stdio: 'inherit' });
  if (result.error !== undefined) throw result.error;
  return result.status ?? 1;
}

if (process.argv[1] !== undefined && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  const raw = process.env['PR_LINT_PLAN'];
  if (!raw) throw new Error('PR_LINT_PLAN is required');
  const plan: unknown = JSON.parse(raw);
  process.exitCode = runSelectedLint(parsePrLintPlan(plan));
}
