import { readMergeGroupEvent } from '../../ciEvent.ts';
import { createGithubRequester } from '../../ios/shared/githubRest.ts';
import { requiredEnv } from '../../ios/shared/actionIo.ts';
import { cancelWorkflowRun, queueCandidateGone } from '../../mergeQueueCandidateGone.ts';

/**
 * "Cancel deleted queue candidate": the only iOS job holding `actions: write`
 * for this purpose, and it runs only this trusted-base program. The gate
 * reported the candidate gone; this re-proves it from the merge_group payload
 * and the REST API before cancelling the run, so a gate output alone can
 * never cancel a live candidate.
 */
const event = readMergeGroupEvent();
if (event === undefined) throw new Error('Cancel deleted queue candidate ran outside a merge_group event.');
const lookup = {
  apiUrl: process.env['GITHUB_API_URL'] ?? 'https://api.github.com',
  repository: event.repository,
  queueRef: event.queueRef,
  request: createGithubRequester({ tokens: [requiredEnv('GITHUB_TOKEN')] }),
};
if (await queueCandidateGone(lookup)) {
  await cancelWorkflowRun({ ...lookup, runId: requiredEnv('GITHUB_RUN_ID') });
  console.log(`::notice::Merge queue candidate ${event.queueRef} was deleted; cancelled this run.`);
} else {
  console.log(`::notice::${event.queueRef} still exists; nothing to cancel.`);
}
