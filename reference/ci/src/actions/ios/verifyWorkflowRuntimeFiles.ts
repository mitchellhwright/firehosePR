import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { credentialTokens, createGithubReader } from '../../ios/shared/githubRest.ts';
import { requiredEnv } from '../../ios/shared/actionIo.ts';
import { error, notice, runAsyncStepProgram, type StepDecision } from '../../ios/shared/stepDecision.ts';
import { filesFromGithubTree, missingWorkflowRuntimeFiles, workflowRuntimeClosure } from '../../workflowRuntimeSkew.ts';

await runAsyncStepProgram('Workflow runtime preflight', async (): Promise<StepDecision> => {
  const head = requiredEnv('EXACT_HEAD_SHA');
  if (!/^[0-9a-f]{40}$/.test(head)) throw new Error('EXACT_HEAD_SHA must be a commit SHA.');
  const workflow = readFileSync(requiredEnv('WORKFLOW_PATH'), 'utf8');
  const workflowRoot = requiredEnv('WORKFLOW_CHECKOUT_ROOT');
  const required = workflowRuntimeClosure(workflow, (path) => readFileSync(join(workflowRoot, path), 'utf8'));
  if (required.length === 0) throw new Error('Executing workflow lists no repository runtime files.');

  const read = createGithubReader({ tokens: credentialTokens(requiredEnv('GH_TOKEN'), '') });
  const url = `${requiredEnv('GITHUB_API_URL')}/repos/${requiredEnv('HEAD_REPOSITORY')}`
    + `/git/trees/${head}?recursive=1`;
  const response = await read(url);
  if (response.status !== 200) {
    throw new Error(`Reading PR head file tree returned HTTP ${response.statusLabel}.`);
  }
  const missing = missingWorkflowRuntimeFiles(required, filesFromGithubTree(response.body));
  if (missing.length > 0) {
    return {
      messages: [error(
        `Exact head ${head.slice(0, 7)} lacks ${missing.length} file(s) used by the executing iOS workflow: `
        + `${missing.slice(0, 8).join(', ')}${missing.length > 8 ? ', …' : ''}. `
        + 'Update the PR branch onto develop before allocating a Mac.',
      )],
      exitCode: 1,
    };
  }
  return {
    messages: [notice(`Exact head ${head.slice(0, 7)} contains all ${required.length} executing iOS workflow runtime files.`)],
    exitCode: 0,
  };
});
