import { z } from 'zod';

const sha = z.string().regex(/^[a-f0-9]{40}$/);
const inputSchema = z.object({
  number: z.number().int().positive(),
  headSha: sha, baseSha: sha,
  headRef: z.string().min(1), baseRef: z.string().min(1),
});
export type PinnedBaseUpdate = z.infer<typeof inputSchema>;
export interface NativeResponse { readonly status: number; readonly body: unknown }
export interface PinnedBasePort {
  readonly read: (path: string) => Promise<NativeResponse>;
  readonly createCommit: (input: {
    readonly message: string; readonly tree: string; readonly parents: readonly [string, string];
  }) => Promise<NativeResponse>;
  readonly publish: (input: {
    readonly name: string; readonly beforeOid: string; readonly afterOid: string; readonly force: false;
  }) => Promise<NativeResponse>;
  readonly wait: () => Promise<void>;
}
export type PinnedBaseOutcome =
  | { readonly kind: 'updating' }
  | { readonly kind: 'superseded' | 'candidate-unavailable' };
const commitSchema = z.object({ sha, tree: z.object({ sha }), parents: z.array(z.object({ sha })) });

/**
 * Update Branch guards only the PR head; a concurrent retarget can change its
 * merge source. Instead use GitHub's computed candidate, verify both immutable
 * parents, and publish with GitHub's atomic beforeOid guard. No local merge
 * engine, temporary branch, or unguarded force update is involved.
 */
export async function publishPinnedBaseUpdate(
  value: PinnedBaseUpdate,
  port: PinnedBasePort,
  stillCurrent: () => Promise<boolean>,
): Promise<PinnedBaseOutcome> {
  const input = inputSchema.parse(value);
  // Never allow a feature-branch update to name the protected target itself.
  if (input.headRef === input.baseRef || ['main', 'develop'].includes(input.headRef)) {
    throw new Error('Refusing to publish a PR update to a protected target branch');
  }
  // GitHub refreshes refs/pull/N/merge asynchronously after a retarget. Retry
  // only missing/stale candidates, not authentication or malformed responses.
  for (let attempt = 0; attempt < 6; attempt += 1) {
    if (!await stillCurrent()) return { kind: 'superseded' };
    const ref = await port.read(`git/ref/pull/${input.number}/merge`);
    if (ref.status !== 200 && ref.status !== 404) throw new Error(`Cannot read integration candidate: HTTP ${ref.status}`);
    if (ref.status === 200) {
      const candidateSha = z.object({ object: z.object({ sha }) }).parse(ref.body).object.sha;
      const response = await port.read(`git/commits/${candidateSha}`);
      if (response.status !== 200) throw new Error(`Cannot inspect integration candidate: HTTP ${response.status}`);
      const candidate = commitSchema.parse(response.body);
      if (candidate.sha !== candidateSha) throw new Error('Integration candidate identity mismatch');
      if (candidate.parents.length === 2 && candidate.parents[0]?.sha === input.baseSha
        && candidate.parents[1]?.sha === input.headSha) {
        if (!await stillCurrent()) return { kind: 'superseded' };
        // Preserve the head-first topology expected by evidence reuse. The
        // tree comes exclusively from GitHub's verified integration candidate.
        const created = await port.createCommit({
          message: `chore: update PR #${input.number} from ${input.baseRef}`,
          tree: candidate.tree.sha, parents: [input.headSha, input.baseSha],
        });
        if (created.status !== 201) throw new Error(`Cannot create pinned base merge: HTTP ${created.status}`);
        const commit = commitSchema.parse(created.body);
        if (commit.tree.sha !== candidate.tree.sha || commit.parents.length !== 2
          || commit.parents[0]?.sha !== input.headSha || commit.parents[1]?.sha !== input.baseSha) {
          throw new Error('Created merge does not match the verified integration candidate');
        }
        if (!await stillCurrent()) return { kind: 'superseded' };
        const published = await port.publish({
          name: `refs/heads/${input.headRef}`, beforeOid: input.headSha, afterOid: commit.sha, force: false,
        });
        // GraphQL can report errors with HTTP 200. Never claim success from
        // that status alone. A racing head update fails its atomic guard.
        const body = z.object({ data: z.object({ updateRefs: z.unknown() }).nullable().optional(),
          errors: z.array(z.unknown()).optional() }).parse(published.body);
        if (published.status !== 200 || body.errors?.length || !body.data?.updateRefs) {
          const currentRef = await port.read(`git/ref/heads/${input.headRef.split('/').map(encodeURIComponent).join('/')}`);
          if (currentRef.status === 404) return { kind: 'superseded' };
          if (currentRef.status === 200 && z.object({ object: z.object({ sha }) }).parse(currentRef.body).object.sha !== input.headSha) {
            return { kind: 'superseded' };
          }
          throw new Error(`Atomic branch update failed: HTTP ${published.status}`);
        }
        return { kind: 'updating' };
      }
    }
    if (attempt < 5) await port.wait();
  }
  return { kind: 'candidate-unavailable' };
}
