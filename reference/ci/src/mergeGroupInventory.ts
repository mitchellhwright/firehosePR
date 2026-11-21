import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import { MERGE_QUEUE_REF_PATTERN } from './mergeQueueRef.ts';
import { isMissingRemoteRef, MergeQueueCandidateGone } from './mergeQueueCandidateGone.ts';
import { githubGitEnvironment } from './githubGit.ts';
import { parseGitChangeInventory, type ChangedFileInventory } from './prChangeInventory.ts';
import { runCommand } from './ios/shared/processRunner.ts';

/**
 * The changed-file inventory of a merge queue candidate: `diff(queue base, candidate)`.
 * For a later queue entry GitHub sends the previous entry's candidate as
 * `base_sha` (merge-queue plan S2), so this is that entry's own change on top
 * of the entries ahead of it. Those entries are validated by their own
 * candidates, which ALLGREEN requires to pass.
 *
 * It is read from Git, not from the PR files API, because the PR's own diff is
 * against the base it was opened on while the candidate integrates it with
 * the current queue base. The fetch lands in a throwaway bare repository under
 * `RUNNER_TEMP`, so a partial-clone fetch never registers a promisor remote in
 * a persistent runner workspace that other jobs share.
 */

const commitSha = z.string().regex(/^[0-9a-f]{40}$/);
const revisionSchema = z.object({
  repository: z.string().regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/),
  serverUrl: z.string().url().default('https://github.com'),
  baseSha: commitSha,
  candidateSha: commitSha,
  queueRef: z.string().regex(MERGE_QUEUE_REF_PATTERN),
  token: z.string().min(1),
  temporaryRoot: z.string().min(1),
});
export type MergeGroupInventoryRevision = z.input<typeof revisionSchema>;

export async function readMergeGroupInventory(
  revision: MergeGroupInventoryRevision,
  run: typeof runCommand = runCommand,
  signal?: AbortSignal,
): Promise<ChangedFileInventory> {
  const input = revisionSchema.parse(revision);
  const gitDir = mkdtempSync(join(input.temporaryRoot, 'merge-group-inventory-'));
  const env = githubGitEnvironment(input.token);
  const git = async (args: readonly string[]): Promise<string> => {
    signal?.throwIfAborted();
    const result = await run('git', ['-C', gitDir, ...args], { capture: true, env });
    if (result.status !== 0 && isMissingRemoteRef(result.stderr, input.queueRef)) {
      throw new MergeQueueCandidateGone(input.queueRef);
    }
    if (result.status !== 0) {
      throw new Error(`Merge group inventory git ${args[0]} failed (exit ${result.status}): ${result.stderr}`);
    }
    return result.stdout.trim();
  };
  try {
    await git(['init', '--bare', '--quiet']);
    await git(['remote', 'add', 'origin', `${input.serverUrl}/${input.repository}.git`]);
    // Both tips' trees are all a two-point diff reads. Ancestry (the candidate
    // contains the queue base) is proved through the API before this runs.
    await git(['fetch', '--quiet', '--no-tags', '--depth=1', '--filter=blob:none', 'origin',
      `+${input.baseSha}:refs/example-ci/queue-base`, `+${input.queueRef}:refs/example-ci/queue-candidate`]);
    if (await git(['rev-parse', 'refs/example-ci/queue-base']) !== input.baseSha) {
      throw new Error('Merge queue base changed during inventory collection.');
    }
    if (await git(['rev-parse', 'refs/example-ci/queue-candidate']) !== input.candidateSha) {
      throw new Error(`Merge queue ref ${input.queueRef} no longer points at candidate ${input.candidateSha}.`);
    }
    const status = await run('git', ['-C', gitDir, 'diff', '--name-status', '-z', '--find-renames',
      input.baseSha, input.candidateSha], { capture: true, env });
    if (status.status !== 0) {
      throw new Error(`Merge group inventory git diff failed (exit ${status.status}): ${status.stderr}`);
    }
    return parseGitChangeInventory(status.stdout);
  } finally {
    rmSync(gitDir, { recursive: true, force: true });
  }
}
