import { readFileSync, appendFileSync } from 'node:fs';
import { z } from 'zod';
import { createPinnedBaseGithubClient } from '../pinnedBaseGithub.ts';
import { recoverRetargetedPullRequest } from '../retargetRecovery.ts';
import { readStepEnvironment } from '../ios/shared/stepEnvironment.ts';

const env = readStepEnvironment(z.object({
  GITHUB_EVENT_PATH: z.string().min(1),
  REPOSITORY: z.string().regex(/^[\w.-]+\/[\w.-]+$/),
  READ_TOKEN: z.string().min(1), UPDATE_TOKEN: z.string().min(1),
  GITHUB_STEP_SUMMARY: z.string().optional(),
}));
const event: unknown = JSON.parse(readFileSync(env.GITHUB_EVENT_PATH, 'utf8'));
const result = await recoverRetargetedPullRequest(event, createPinnedBaseGithubClient({
  repository: env.REPOSITORY, readToken: env.READ_TOKEN, updateToken: env.UPDATE_TOKEN,
}));
console.log(JSON.stringify({ schema: 'example.retarget-recovery.v1', ...result }));
if (env.GITHUB_STEP_SUMMARY) appendFileSync(env.GITHUB_STEP_SUMMARY,
  `## Retargeted PR candidate\n\nResult: **${result.kind}**. A requested update is complete only after GitHub emits the new synchronize event and its checks pass.\n`);
