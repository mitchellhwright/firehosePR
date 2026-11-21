import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { selectChecks } from '../src/checkRunner.ts';
import { installWorkflowContractDependencies } from '../src/actions/installWorkflowContractDependencies.ts';

const args = process.argv.slice(2);
if (args.length > 1 || (args.length === 1 && args[0] !== '--workflow-contracts')) {
  throw new Error('Usage: ci:check [--workflow-contracts]');
}
let checks = selectChecks(JSON.parse(readFileSync('package.json', 'utf8')));
if (args[0] === '--workflow-contracts') {
  if (checks[0] !== 'ci:deps') throw new Error('Workflow contracts require ci:deps to own CI dependencies');
  // This mode owns installation and the root resolution link in one call. There
  // is no preinstalled flag or cached assertion that can skip lockfile validation.
  const status = installWorkflowContractDependencies();
  if (status !== 0) process.exit(status);
  checks = checks.slice(1);
}

console.log(`ci:check runs ${checks.length} script(s): ${checks.join(', ')}`);
for (const script of checks) {
  console.log(`\n> npm run ${script}`);
  const result = spawnSync('npm', ['run', '-s', script], { stdio: 'inherit' });
  if (result.status !== 0) {
    console.error(`::error::${script} failed (exit ${result.status ?? 'signal'}).`);
    process.exit(result.status ?? 1);
  }
}
