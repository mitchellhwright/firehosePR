import { findPromotionEvidence, promotionRequirementsSchema } from '../../ios/promotionEvidence.ts';
import { createGithubReader, credentialTokens } from '../../ios/shared/githubRest.ts';
import { appendStepOutputs, requiredEnv, runStep } from '../../ios/shared/stepIo.ts';

const shaPattern = /^[a-f0-9]{40}$/;
const repositoryPattern = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;

/** Read only the trusted workflow's exact-SHA dispatches; a no-op success is insufficient. */
export async function verifyPromotionEvidence(): Promise<void> {
  const checkpointSha = requiredEnv('PROMOTION_CHECKPOINT_SHA');
  const baseSha = requiredEnv('PROMOTION_BASE_SHA');
  const requirements = promotionRequirementsSchema.parse({
    nativeLanes: JSON.parse(requiredEnv('PROMOTION_NATIVE_LANES')) as unknown,
    producerRequired: requiredEnv('PROMOTION_PRODUCER_REQUIRED') === 'true',
    storekitRequired: requiredEnv('PROMOTION_STOREKIT_REQUIRED') === 'true',
    archiveRequired: requiredEnv('PROMOTION_ARCHIVE_REQUIRED') === 'true',
  });
  if (requiredEnv('PROMOTION_DETECT_OUTCOME') !== 'success') {
    throw new Error('Promotion changed-file inventory was not classified successfully.');
  }
  const changedFiles = process.env.PROMOTION_NATIVE_CHANGED_FILES;
  if (changedFiles === undefined) {
    throw new Error('Promotion native-file inventory was not provided.');
  }
  if (requiredEnv('PROMOTION_PLANNER_OUTCOME') !== 'success') {
    throw new Error('Promotion native plan did not complete for the classified file inventory.');
  }
  const repository = requiredEnv('REPOSITORY');
  if (!shaPattern.test(checkpointSha) || !shaPattern.test(baseSha) || !repositoryPattern.test(repository)) {
    throw new Error('Invalid promotion checkpoint SHA or repository identity.');
  }
  const api = requiredEnv('GITHUB_API_URL').replace(/\/$/, '');
  const read = createGithubReader({
    tokens: credentialTokens(requiredEnv('GITHUB_TOKEN'), process.env.GITHUB_FALLBACK_TOKEN ?? ''),
  });
  const proof = await findPromotionEvidence({ api, repository, checkpointSha, baseSha, requirements, read });
  appendStepOutputs([
    { key: 'proven', value: 'true' },
    { key: 'run_id', value: String(proof.runId) },
    { key: 'run_attempt', value: String(proof.runAttempt) },
  ]);
  process.stdout.write(`::notice::Exact-develop selected iOS/StoreKit/Release and required onboarding evidence: run ${proof.runId} attempt ${proof.runAttempt}.\n`);
}

await runStep('Promotion evidence', verifyPromotionEvidence);
