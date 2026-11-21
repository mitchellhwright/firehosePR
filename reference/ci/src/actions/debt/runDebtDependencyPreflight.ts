import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import { readMergeGroupEvent, type MergeGroupEventTuple } from '../../ciEvent.ts';
import { createGithubReader, credentialTokens } from '../../ios/shared/githubRest.ts';
import { installSignalTraps, runCommand } from '../../ios/shared/processRunner.ts';
import { ensurePolicyHistory } from './ensurePolicyHistory.ts';

function required(name: 'GITHUB_EVENT_PATH' | 'DEBT_PREFLIGHT_OUTPUT' | 'RUNNER_TEMP'): string {
  const value = process.env[name];
  if (value === undefined || value.length === 0) throw new Error(`${name} is required`);
  return value;
}

/**
 * The preflight selects tickets from the PR body and the evidence files the
 * change touches. A queue candidate's payload carries no PR body, so the body
 * is read from the queued PR and the change is described as the candidate
 * against its queue base.
 */
async function mergeGroupEventPath(event: MergeGroupEventTuple): Promise<string> {
  const apiUrl = process.env['GITHUB_API_URL'] ?? 'https://api.github.com';
  const read = createGithubReader({ tokens: credentialTokens(process.env['GITHUB_TOKEN'] ?? '', '') });
  const response = await read(`${apiUrl}/repos/${event.repository}/pulls/${event.prNumber}`);
  if (response.status !== 200) {
    throw new Error(`Could not read queued pull request #${event.prNumber} body: HTTP ${response.statusLabel}`);
  }
  const { body } = z.object({ body: z.string().nullable() }).parse(response.body);
  const path = join(required('RUNNER_TEMP'), 'merge-group-debt-preflight-event.json');
  writeFileSync(path, `${JSON.stringify({
    repository: { full_name: event.repository },
    pull_request: {
      body,
      head: { sha: event.headSha },
      base: { sha: event.trustedBaseSha, ref: event.baseBranch },
    },
  })}\n`);
  return path;
}

installSignalTraps(() => {});

await ensurePolicyHistory(process.cwd(), {
  token: process.env['GITHUB_TOKEN'] ?? '',
  serverUrl: process.env['GITHUB_SERVER_URL'] ?? '',
  repository: process.env['GITHUB_REPOSITORY'] ?? '',
});

// Preserve the policy job's two sequential obligations and their exit status
// while moving their orchestration out of the shell wrapper.
const policy = await runCommand(process.execPath, ['ci/src/actions/runPrValidationPolicyTests.ts']);
if (policy.status !== 0) {
  process.exitCode = policy.status;
} else {
  const mergeGroup = readMergeGroupEvent();
  const eventPath = mergeGroup === undefined ? required('GITHUB_EVENT_PATH') : await mergeGroupEventPath(mergeGroup);
  const preflight = await runCommand(process.execPath, [
    'ci/src/actions/debt/runDebtProjectionPreflight.ts',
    '--event-path', eventPath,
    '--output-dir', required('DEBT_PREFLIGHT_OUTPUT'),
  ]);
  process.exitCode = preflight.status;
}
