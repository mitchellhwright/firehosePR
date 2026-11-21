import { appendStepOutputs, requiredEnv, runStep } from '../ios/shared/stepIo.ts';
import { CheckpointApi } from '../promotion/checkpointApi.ts';
import { createImmutablePromotionCheckpoint } from '../promotion/checkpointTransaction.ts';
import { marketingVersionProjectPath, nextPromotionVersion, readAppleVersions, readMarketingVersion } from '../promotion/marketingVersion.ts';
import { trustedVersionAttestations } from '../promotion/versionAttestation.ts';
import { createAppStoreConnectToken } from './reconcileXcodeCloudBuildTags.ts';

await runStep('Promotion checkpoint transaction', async () => {
  const repository = requiredEnv('REPOSITORY');
  const api = new CheckpointApi(
    requiredEnv('GITHUB_API_URL'),
    requiredEnv('GH_TOKEN'),
    repository,
  );
  const sourceSha = requiredEnv('HEAD_SHA');
  const originalNumber = Number(requiredEnv('ORIGINAL_PR_NUMBER'));
  const sourceProject = await api.readFile(marketingVersionProjectPath, sourceSha);
  const sourceVersion = readMarketingVersion(sourceProject);
  const prior = trustedVersionAttestations(await api.comments(originalNumber), sourceSha);
  const distinct = [...new Map(prior.map((item) => [`${item.commitSha}:${item.version}`, item])).values()];
  if (distinct.length > 1) throw new Error('The checkpoint App recorded conflicting versions for this exact source.');
  let marketingVersion: string;
  if (distinct[0] !== undefined) {
    marketingVersion = distinct[0].version;
    console.log(`Reusing the checkpoint App's immutable iOS version selection ${marketingVersion}.`);
  } else {
    const appleToken = createAppStoreConnectToken({
      issuerId: requiredEnv('APP_STORE_CONNECT_API_KEY_ISSUER_ID'),
      keyId: requiredEnv('APP_STORE_CONNECT_API_KEY_ID'),
      privateKey: requiredEnv('APP_STORE_CONNECT_API_KEY_CONTENT'),
    });
    const [versions, reservations, mainSha] = await Promise.all([
      readAppleVersions(requiredEnv('APP_STORE_CONNECT_APP_ID'), appleToken),
      api.promotionVersionReservations(sourceSha),
      api.ref('main'),
    ]);
    if (mainSha === null) throw new Error('Cannot select a promotion version without the exact main SHA.');
    const mainVersion = readMarketingVersion(await api.readFile(marketingVersionProjectPath, mainSha));
    marketingVersion = nextPromotionVersion(sourceVersion, versions, [...reservations, mainVersion]);
  }
  console.log(`Preparing iOS marketing version ${marketingVersion} for the immutable promotion checkpoint.`);
  const result = await createImmutablePromotionCheckpoint(api, {
    repository,
    repositoryOwner: requiredEnv('REPOSITORY_OWNER'),
    originalNumber,
    sourceSha,
    sourceVersion,
    marketingVersion,
    selectedCommitSha: distinct[0]?.commitSha ?? null,
  });
  appendStepOutputs([
    { key: 'checkpoint_branch', value: result.branch },
    { key: 'checkpoint_pr_number', value: String(result.number) },
    { key: 'checkpoint_url', value: result.url },
    { key: 'checkpoint_head', value: result.headSha },
    { key: 'checkpoint_base', value: result.baseSha },
  ]);
});
