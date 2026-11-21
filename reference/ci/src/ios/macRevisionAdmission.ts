import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { executionTupleDecision, readCurrentPullRequestTuple } from './currentPullRequestTuple.ts';
import { optionalEnv, requiredEnv } from './shared/actionIo.ts';
import { headRevision } from './shared/gitRevision.ts';
import { createGithubReader, credentialTokens } from './shared/githubRest.ts';
import { error, fail, pass, type StepDecision } from './shared/stepDecision.ts';

/** Reject a guard executed from a checkout other than the gate-proven verifier. */
export async function trustedGuardRevisionDecision(
  entryUrl: string,
  expected: string,
  revision: typeof headRevision = headRevision,
): Promise<StepDecision> {
  const actual = await revision(dirname(fileURLToPath(entryUrl)));
  return actual === expected && expected.length > 0 ? pass() : fail(error(
    `iOS admission guard checkout ${actual || 'unreadable'} does not match trusted verifier ${expected}.`,
  ));
}

/** Trusted program, actual product checkout, then the same live tuple Linux checked. */
export async function macRevisionAdmission(entryUrl: string): Promise<StepDecision> {
  const trusted = await trustedGuardRevisionDecision(entryUrl, requiredEnv('EXAMPLE_CI_GUARD_SHA'));
  if (trusted.exitCode !== 0) return trusted;
  const expectedProduct = requiredEnv('EXACT_HEAD_SHA');
  const actualProduct = await headRevision(requiredEnv('GITHUB_WORKSPACE'));
  if (actualProduct !== expectedProduct) return fail(error(
    `Checked out ${actualProduct || 'unreadable'}, expected exact head ${expectedProduct}.`,
  ));
  const prNumber = optionalEnv('EXAMPLE_CI_PR_NUMBER');
  if (prNumber.length === 0) return pass();
  return executionTupleDecision(await readCurrentPullRequestTuple({
    expected: {
      prNumber,
      headSha: requiredEnv('EXAMPLE_CI_EXACT_HEAD_SHA'),
      baseSha: requiredEnv('EXAMPLE_CI_TRUSTED_BASE_SHA'),
      baseRef: requiredEnv('EXAMPLE_CI_TRUSTED_BASE_REF'),
    },
    repository: requiredEnv('GITHUB_REPOSITORY'),
    apiUrl: requiredEnv('GITHUB_API_URL'),
    read: createGithubReader({ tokens: credentialTokens(requiredEnv('GH_TOKEN'), '') }),
  }));
}
