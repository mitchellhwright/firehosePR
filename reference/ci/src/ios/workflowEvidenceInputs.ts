import type { Comparison, ComparisonFile } from '../../../scripts/ci/types/github.d.mts';
import { verifiedGitBlobSource } from '../githubGitBlob.ts';
import { iosE2eProductInputDigest, iosE2eProductWorkflowSha, iosExecutionScopeChanged, iosExecutionScopeChangedPaths } from './iosExecutionInputs.ts';
import { sameQueueLaneExecutionContract } from './queueLaneExecutionContract.ts';
import { QUEUE_REUSE_LANES } from './queueEvidenceReuseRecord.ts';

export interface IosWorkflowInputProof {
  priorHead: string;
  currentHead: string;
  digest: string;
  workflowEvidenceEquivalent?: boolean;
}

/** Only a hash-verified, producer-and-all-lanes-equivalent workflow edit may
 * leave the global invalidation set. Keep original comparisons for patch and
 * ancestry proof; this projection is solely for the iOS execution planner. */
export function iosProductVerifiedLineageFiles(
  files: readonly ComparisonFile[] | undefined,
  proof: IosWorkflowInputProof | undefined,
  priorHead: string,
  currentHead: string,
): readonly ComparisonFile[] | undefined {
  if (proof?.priorHead !== priorHead || proof.currentHead !== currentHead
    || !/^[a-f0-9]{64}$/.test(proof.digest) || proof.workflowEvidenceEquivalent !== true) return files;
  return files?.filter((file) => file.filename !== '.github/workflows/ios-tests.yml'
    || file.status !== 'modified' || file.previous_filename !== undefined);
}

export async function loadIosWorkflowInputProof({ priorHead, currentHead, read }: {
  priorHead: string;
  currentHead: string;
  read: (path: string) => Promise<unknown>;
}): Promise<IosWorkflowInputProof | null> {
  if (!/^[a-f0-9]{40}$/.test(priorHead) || !/^[a-f0-9]{40}$/.test(currentHead)) return null;
  const [priorTree, currentTree] = await Promise.all([
    read(`git/trees/${priorHead}?recursive=1`),
    read(`git/trees/${currentHead}?recursive=1`),
  ]);
  const priorWorkflowSha = iosE2eProductWorkflowSha(priorTree);
  const currentWorkflowSha = iosE2eProductWorkflowSha(currentTree);
  if (priorWorkflowSha === null || currentWorkflowSha === null) return null;
  const [priorWorkflow, currentWorkflow] = await Promise.all([
    read(`git/blobs/${priorWorkflowSha}`),
    priorWorkflowSha === currentWorkflowSha
      ? Promise.resolve(null) : read(`git/blobs/${currentWorkflowSha}`),
  ]);
  const priorDigest = iosE2eProductInputDigest(priorTree, priorWorkflow);
  const currentDigest = iosE2eProductInputDigest(currentTree,
    priorWorkflowSha === currentWorkflowSha ? priorWorkflow : currentWorkflow);
  if (priorDigest === null || currentDigest === null || priorDigest !== currentDigest) return null;
  const priorSource = verifiedGitBlobSource(priorWorkflow, priorWorkflowSha);
  const currentSource = verifiedGitBlobSource(priorWorkflowSha === currentWorkflowSha ? priorWorkflow : currentWorkflow, currentWorkflowSha);
  const workflowEvidenceEquivalent = priorSource !== null && currentSource !== null
    && QUEUE_REUSE_LANES.every((lane) => sameQueueLaneExecutionContract(priorSource, currentSource, lane));
  return { priorHead, currentHead, digest: currentDigest, workflowEvidenceEquivalent };
}

/** One execution-equivalence boundary for planning, cancellation and resumption.
 * Original ancestry and patch comparisons stay intact at every caller. */
export async function isReusableIosWorkflowLineage({ comparison, priorHead, currentHead, read }: {
  comparison: Comparison | undefined;
  priorHead: string;
  currentHead: string;
  read: (path: string) => Promise<unknown>;
}): Promise<boolean> {
  if (comparison === undefined) return true;
  const changed = iosExecutionScopeChangedPaths(comparison.files);
  if (changed === null) return false;
  if (changed.length === 0) return true;
  if (changed.some((path) => path !== '.github/workflows/ios-tests.yml')) return false;
  const proof = await loadIosWorkflowInputProof({ priorHead, currentHead, read });
  return !iosExecutionScopeChanged(iosProductVerifiedLineageFiles(
    comparison.files, proof ?? undefined, priorHead, currentHead,
  ));
}
