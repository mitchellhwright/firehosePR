import { logLine, requiredEnv } from '../../ios/shared/actionIo.ts';
import {
  createGithubReader,
  createGithubRequester,
  credentialTokens,
} from '../../ios/shared/githubRest.ts';
import {
  error,
  fail,
  info,
  pass,
  runAsyncStepProgram,
  type StepDecision,
} from '../../ios/shared/stepDecision.ts';
import {
  artifactDeletionUrl,
  artifactListingUrl,
  artifactPassLimit,
  hasFurtherPage,
  isRunIdentifier,
  removableArtifacts,
  removalLine,
  removalSummary,
  type RunArtifact,
} from '../../ios/runArtifactCleanup.ts';

/**
 * "Delete this run's artifacts".
 *
 * Runs only once every producer has finished without failing or being
 * cancelled, so nothing can rerun against these artifacts and nobody needs to
 * read them. The listing and the deletions both go through the shared GitHub
 * client, which carries the credential fallback and the status contract the
 * control steps already rely on.
 */
await runAsyncStepProgram('Run artifact cleanup', async (): Promise<StepDecision> => {
  const runId = requiredEnv('RUN_ID');
  if (!isRunIdentifier(runId)) {
    return fail(error('Refusing to enumerate artifacts for a non-numeric run id.'));
  }
  const apiUrl = requiredEnv('GITHUB_API_URL');
  const repository = requiredEnv('REPOSITORY');
  const tokens = credentialTokens(requiredEnv('GH_TOKEN'), '');
  const read = createGithubReader({ tokens });
  const request = createGithubRequester({ tokens });

  let removed = 0;
  for (let sweep = 1; sweep <= artifactPassLimit; sweep += 1) {
    const listing = await read(artifactListingUrl(apiUrl, repository, runId));
    if (listing.statusLabel !== '200') {
      return fail(error(`Could not list run ${runId} artifacts: HTTP ${listing.statusLabel}.`));
    }
    const artifacts = removableArtifacts(listing.body);
    for (const artifact of artifacts) {
      const failure = await remove(request, apiUrl, repository, artifact);
      if (failure !== null) return fail(error(failure));
      removed += 1;
    }
    if (!hasFurtherPage(artifacts.length)) break;
  }
  return pass(info(removalSummary(removed, runId)));
});

async function remove(
  request: ReturnType<typeof createGithubRequester>,
  apiUrl: string,
  repository: string,
  artifact: RunArtifact,
): Promise<string | null> {
  const url = artifactDeletionUrl(apiUrl, repository, artifact.id);
  const response = await request('DELETE', url);
  // 404 means another job in this run already removed it, which is a success.
  if (response.status !== 204 && response.status !== 404) {
    return `Could not remove artifact ${artifact.name}: HTTP ${response.statusLabel}.`;
  }
  logLine(removalLine(artifact));
  return null;
}
