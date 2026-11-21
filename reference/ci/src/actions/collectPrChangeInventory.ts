import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import { installSignalTraps } from '../ios/shared/processRunner.ts';
import { readMergeGroupEvent, type MergeGroupEventTuple } from '../ciEvent.ts';
import { verifyMergeGroupCandidate } from '../mergeGroupCandidate.ts';
import { readMergeGroupInventory } from '../mergeGroupInventory.ts';
import { cancelWorkflowRun, MergeQueueCandidateGone, queueCandidateGone } from '../mergeQueueCandidateGone.ts';
import { collectPrChangeInventory, selectPrInventorySource, type ChangedFileInventory, type SelectedPrInventory } from '../prChangeInventory.ts';
import { createGithubReader, createGithubRequester, credentialTokens } from '../ios/shared/githubRest.ts';
import { prValidationPlanning } from '../prValidationPlanning.ts';
import { appendStepOutputs } from '../ios/shared/githubOutputs.ts';
import { readStepEnvironment } from '../ios/shared/stepEnvironment.ts';

const flag = z.enum(['true', 'false', '']).default('').transform(value => value === 'true');
const environment = readStepEnvironment(z.object({
  RUNNER_TEMP: z.string().min(1),
  DELETED_FILES_INVENTORY_FILE: z.string().min(1),
  EVENT_NAME: z.string(), PR_NUMBER: z.string().default(''), REPOSITORY: z.string().default(''),
  BASE_SHA: z.string().default(''), HEAD_SHA: z.string().default(''), MERGE_GROUP_REF: z.string().default(''),
  GITHUB_API_URL: z.string().default('https://api.github.com'),
  GITHUB_SERVER_URL: z.string().default('https://github.com'),
  GITHUB_TOKEN: z.string().default(''), GITHUB_FALLBACK_TOKEN: z.string().default(''),
  GITHUB_RUN_ID: z.string().default(''),
  CONTROLLER_BASE_UPDATE_SUPERSEDED: flag, CONTROLLER_BASE_UPDATE_VALID: flag,
  CONTROLLER_BASE_UPDATE_FILES: z.string().default(''), CONTROLLER_BASE_UPDATE_PATCH_EQUIVALENT: flag,
}));
const changedPath = join(environment.RUNNER_TEMP, 'pr-changed-files.txt');
// A reused runner must not expose a prior attempt's inventory when collection fails.
writeFileSync(environment.DELETED_FILES_INVENTORY_FILE, '');
writeFileSync(changedPath, '');
const cancellation = new AbortController();
process.once('SIGINT', () => cancellation.abort());
process.once('SIGTERM', () => cancellation.abort());
let operation: Promise<ChangedFileInventory> | undefined;
installSignalTraps(async () => {
  try { await operation; } catch { /* Preserve the cancellation status after scoped cleanup. */ }
});
/**
 * A queue candidate is planned from its own diff against the queue base, and
 * only after its PR is proved open, same-repository and exactly integrated.
 */
async function mergeGroupInventory(event: MergeGroupEventTuple): Promise<ChangedFileInventory> {
  if (environment.BASE_SHA !== event.trustedBaseSha || environment.HEAD_SHA !== event.headSha
    || environment.MERGE_GROUP_REF !== event.queueRef) {
    throw new Error('Step environment does not match the merge_group payload tuple.');
  }
  const tokens = credentialTokens(environment.GITHUB_TOKEN, environment.GITHUB_FALLBACK_TOKEN);
  const verification = await verifyMergeGroupCandidate(
    event, environment.GITHUB_API_URL, createGithubReader({ tokens }),
  );
  if (verification.kind === 'rejected') throw new Error(`Merge queue candidate rejected: ${verification.message}`);
  return readMergeGroupInventory({
    repository: event.repository, serverUrl: environment.GITHUB_SERVER_URL,
    baseSha: event.trustedBaseSha, candidateSha: event.headSha, queueRef: event.queueRef,
    token: environment.GITHUB_TOKEN, temporaryRoot: environment.RUNNER_TEMP,
  }, undefined, cancellation.signal);
}

// A queue candidate never takes a base-update classifier inventory: it has no
// prior head, and its obligations are its own diff against the queue base.
const mergeGroup = readMergeGroupEvent();
let inventory: SelectedPrInventory | undefined = mergeGroup === undefined ? selectPrInventorySource({
  superseded: environment.CONTROLLER_BASE_UPDATE_SUPERSEDED,
  valid: environment.CONTROLLER_BASE_UPDATE_VALID,
  files: environment.CONTROLLER_BASE_UPDATE_FILES,
  patchEquivalent: environment.CONTROLLER_BASE_UPDATE_PATCH_EQUIVALENT,
}) : undefined;
if (mergeGroup !== undefined) {
  operation = mergeGroupInventory(mergeGroup);
  try {
    inventory = { ...await operation, source: 'merge-group', metadataOnly: false };
  } catch (error) {
    if (!(error instanceof MergeQueueCandidateGone)) throw error;
    // This planner runs only trusted-base code, so its actions: write token
    // may cancel the run (the job needs that grant for admission probes).
    const lookup = {
      apiUrl: environment.GITHUB_API_URL, repository: mergeGroup.repository, queueRef: mergeGroup.queueRef,
      request: createGithubRequester({ tokens: [environment.GITHUB_TOKEN] }),
    };
    if (!await queueCandidateGone(lookup)) throw error;
    await cancelWorkflowRun({ ...lookup, runId: environment.GITHUB_RUN_ID });
    // The later planning steps skip on this output until the cancellation lands.
    appendStepOutputs([['candidate_gone', 'true']]);
    console.log(`::notice::${error.message} Cancelled this run instead of failing it.`);
    process.exit(0);
  }
}
if (!inventory && environment.EVENT_NAME === 'pull_request' && environment.PR_NUMBER) {
  operation = collectPrChangeInventory({
    repository: environment.REPOSITORY, prNumber: environment.PR_NUMBER,
    baseSha: environment.BASE_SHA, headSha: environment.HEAD_SHA,
    token: environment.GITHUB_TOKEN, fallbackToken: environment.GITHUB_FALLBACK_TOKEN,
  }, undefined, undefined, cancellation.signal);
  inventory = { ...await operation, source: 'pull-request', metadataOnly: false };
}
inventory ??= { source: 'unverified', changed: [], deleted: [], metadataOnly: false };
writeFileSync(changedPath, inventory.changed.join('\n') + '\n');
writeFileSync(environment.DELETED_FILES_INVENTORY_FILE, inventory.deleted.join('\n') + (inventory.deleted.length ? '\n' : ''));
const outputs = {
  metadata_only: String(inventory.metadataOnly),
  classifier_inventory_selected: String(inventory.source === 'classifier'),
  file_status_inventory_verified: String(inventory.source === 'pull-request' || inventory.source === 'merge-group'),
  candidate_gone: 'false',
} satisfies Record<typeof prValidationPlanning.inventory.outputs[number], string>;
appendStepOutputs(Object.entries(outputs));
console.log(`PR inventory: ${inventory.changed.length} changed paths from ${inventory.source}.`);
if (inventory.source === 'classifier' && inventory.metadataOnly) {
  console.log('::notice::Verified target update did not change the effective PR patch; reusing prior validation.');
}
