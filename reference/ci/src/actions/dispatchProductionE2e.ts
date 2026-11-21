import { optionalEnv, requiredEnv } from '../ios/shared/actionIo.ts';
import { runCommand } from '../ios/shared/processRunner.ts';
import {
  error, fail, info, notice, pass, runAsyncStepProgram,
  type StepDecision,
} from '../ios/shared/stepDecision.ts';

const COMMIT_SHA = /^[0-9a-f]{40}$/;

async function githubOutput(args: readonly string[]): Promise<string> {
  const result = await runCommand('gh', [...args], { capture: true, timeoutMs: 30_000 });
  if (result.status !== 0) {
    throw new Error(`gh ${args[0]} failed (${result.status}): ${result.stderr.trim()}`);
  }
  return result.stdout.trim();
}

/**
 * A workflow_dispatch can name only a branch. Dispatch the deployed commit
 * only while it is still main's head, and let the downstream workflow verify
 * the serving revision before it allocates a Mac.
 */
await runAsyncStepProgram('Production onboarding E2E dispatch', async (): Promise<StepDecision> => {
  const deployedSha = optionalEnv('DEPLOYED_SHA');
  if (!COMMIT_SHA.test(deployedSha)) {
    return fail(error(`The production deploy report carried '${deployedSha}', not a 40-character commit SHA.`));
  }
  const repository = requiredEnv('GITHUB_REPOSITORY');
  const workflow = requiredEnv('PRODUCTION_E2E_WORKFLOW');

  const mainSha = await githubOutput(['api', `repos/${repository}/git/ref/heads/main`, '--jq', '.object.sha']);
  if (!COMMIT_SHA.test(mainSha)) {
    return fail(error(`Could not read a valid main commit SHA for ${repository}.`));
  }
  if (mainSha !== deployedSha) {
    return pass(notice(`Deployed ${deployedSha} is no longer the main head ${mainSha}; `
      + "the head's own deploy report verifies production."));
  }

  const activeRuns = await githubOutput([
    'api',
    `repos/${repository}/actions/workflows/${workflow}/runs?event=workflow_dispatch&head_sha=${deployedSha}&per_page=100`,
    '--jq', '[.workflow_runs[] | select(.status != "completed")] | length',
  ]);
  if (!/^(0|[1-9][0-9]*)$/.test(activeRuns)) {
    return fail(error(`Could not read the active production E2E run count for ${deployedSha}.`));
  }
  if (activeRuns !== '0') {
    return pass(notice(`A production E2E run for ${deployedSha} is already queued or running; `
      + 'not dispatching a duplicate.'));
  }

  await githubOutput([
    'workflow', 'run', workflow, '--repo', repository, '--ref', 'main', '-f', `exact_sha=${deployedSha}`,
  ]);
  return pass(info(`Dispatched ${workflow} on main for deployed revision ${deployedSha}.`));
});
