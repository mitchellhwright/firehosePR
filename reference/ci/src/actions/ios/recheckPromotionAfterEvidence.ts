import { readFileSync } from 'node:fs';

import {
  applyRecheck, formatDecision, parseRecheckTrigger, planPromotionRecheck,
  type RecheckDecision,
} from '../../ios/promotionRecheck.ts';
import { appendStepSummary, logLine, requiredEnv } from '../../ios/shared/actionIo.ts';
import { createGithubReader, createGithubRequester } from '../../ios/shared/githubRest.ts';

const repositoryPattern = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u;

function writeSummary(decisions: readonly RecheckDecision[]): void {
  appendStepSummary('## Promotion evidence recheck\n');
  appendStepSummary('| Decision | Pull request | Run | Reason |');
  appendStepSummary('| --- | --- | --- | --- |');
  for (const decision of decisions) {
    appendStepSummary(`| ${decision.action} | ${decision.pullRequest === undefined ? '' : `#${decision.pullRequest}`} `
      + `| ${decision.runId ?? ''} | ${decision.reason} |`);
  }
}

async function main(): Promise<void> {
  const repository = requiredEnv('REPOSITORY');
  if (!repositoryPattern.test(repository)) throw new Error(`Invalid repository identity: ${repository}`);
  const api = requiredEnv('GITHUB_API_URL').replace(/\/$/u, '');
  const tokens = [requiredEnv('GITHUB_TOKEN')];
  const payload = JSON.parse(readFileSync(requiredEnv('GITHUB_EVENT_PATH'), 'utf8')) as unknown;

  const trigger = parseRecheckTrigger(payload, repository);
  const decisions: readonly RecheckDecision[] = trigger.accepted
    ? await planPromotionRecheck({ api, repository, read: createGithubReader({ tokens }) }, trigger.trigger)
    : [{ action: 'none', reason: trigger.reason }];
  for (const decision of decisions) logLine(formatDecision(decision));
  writeSummary(decisions);
  await applyRecheck({ api, repository, request: createGithubRequester({ tokens }) }, decisions);
}

try {
  await main();
} catch (error: unknown) {
  process.stderr.write(`Promotion evidence recheck failed: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
}
