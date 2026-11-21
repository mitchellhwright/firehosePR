import { z } from 'zod';
import type { PinnedBaseUpdate, PinnedBaseOutcome } from './pinnedBaseUpdate.ts';
import { promotionCheckpointSha } from './ios/iosGatePrecheck.ts';

const sha = z.string().regex(/^[a-f0-9]{40}$/);
const repositoryName = z.string().regex(/^[\w.-]+\/[\w.-]+$/);
const repository = z.object({ full_name: repositoryName });
const pullSchema = z.object({
  user: z.object({ login: z.string().min(1) }),
  number: z.number().int().positive(), state: z.enum(['open', 'closed']),
  head: z.object({ sha, ref: z.string().min(1), repo: repository.nullable() }),
  base: z.object({ sha, ref: z.string().min(1), repo: repository }),
  merge_commit_sha: sha.nullable(),
});
const eventSchema = z.object({
  action: z.string(), repository,
  pull_request: pullSchema.omit({ state: true }),
  changes: z.object({ base: z.object({ ref: z.object({ from: z.string() }).optional() }).optional() }).optional(),
});
export type RetargetEvent = z.infer<typeof eventSchema>;
export interface RetargetResponse { readonly status: number; readonly body: unknown }
export interface RetargetPort {
  readonly read: (path: string) => Promise<RetargetResponse>;
  readonly update: (input: PinnedBaseUpdate, stillCurrent: () => Promise<boolean>) => Promise<PinnedBaseOutcome>;
}
export type RetargetOutcome =
  | { readonly kind: 'ignored' | 'superseded' | 'current' | 'candidate-current' | 'candidate-unavailable' }
  | { readonly kind: 'updating'; readonly number: number };

/** A retarget event, or a ready event with a proven stale candidate, owns this repair. */
export async function recoverRetargetedPullRequest(value: unknown, port: RetargetPort): Promise<RetargetOutcome> {
  const event = eventSchema.parse(value);
  const changedBase = event.action === 'edited' && event.changes?.base?.ref !== undefined;
  if (!changedBase && event.action !== 'ready_for_review') return { kind: 'ignored' };
  const expected = event.pull_request;
  const eligible = (pull: RetargetEvent['pull_request']): boolean =>
    pull.head.repo?.full_name === event.repository.full_name
    && pull.base.repo.full_name === event.repository.full_name
    && (pull.base.ref === 'develop' || (changedBase && pull.base.ref === 'main'))
    && (changedBase || promotionCheckpointSha(pull.head.ref) === null);
  if (!eligible(expected)) return { kind: 'ignored' };
  const livePull = async () => {
    const response = await port.read(`pulls/${expected.number}`);
    if (response.status !== 200) throw new Error(`Cannot read retargeted PR: HTTP ${response.status}`);
    return pullSchema.parse(response.body);
  };
  const matches = (pull: z.infer<typeof pullSchema>): boolean => pull.state === 'open'
    && eligible(pull) && pull.head.sha === expected.head.sha && pull.head.ref === expected.head.ref
    && pull.base.sha === expected.base.sha && pull.base.ref === expected.base.ref;
  const live = await livePull();
  if (!matches(live)) return { kind: 'superseded' };
  // Dependabot owns routine rebases, but an explicit base retarget changes the
  // integration candidate and needs a new head even for a dependency PR.
  if (!changedBase && live.user.login === 'dependabot[bot]') return { kind: 'ignored' };
  if (!changedBase) {
    // Automatic stacked-PR retargeting can leave GitHub's cached merge SHA at
    // the old base when ready_for_review is emitted. Do not update every PR
    // merely because it was marked ready: prove this specific mismatch first.
    // Inspect the event's immutable candidate, even if GitHub refreshed its
    // live cache since emitting that event; its CI run still has the old SHA.
    if (expected.merge_commit_sha === null) return { kind: 'candidate-unavailable' };
    const candidate = await port.read(`git/commits/${expected.merge_commit_sha}`);
    if (candidate.status !== 200) throw new Error(`Cannot inspect PR candidate: HTTP ${candidate.status}`);
    const { parents } = z.object({ parents: z.array(z.object({ sha })) }).parse(candidate.body);
    if (parents.length !== 2) return { kind: 'candidate-unavailable' };
    if (parents[1]?.sha !== expected.head.sha) return { kind: 'candidate-unavailable' };
    if (parents[0]?.sha === expected.base.sha) return { kind: 'candidate-current' };
  }
  if (!changedBase) {
    const comparison = await port.read(`compare/${expected.base.sha}...${expected.head.sha}`);
    if (comparison.status !== 200) throw new Error(`Cannot compare retargeted PR: HTTP ${comparison.status}`);
    const { behind_by: behind } = z.object({ behind_by: z.number().int().nonnegative() }).parse(comparison.body);
    if (behind === 0) return { kind: 'current' };
  }
  // Retargeting requires a new synchronize event even if the new base is an
  // ancestor of the head. The old required checks may describe a different
  // integration candidate and GitHub does not start them on edited anymore.
  const outcome = await port.update({
    number: expected.number, headSha: expected.head.sha, headRef: expected.head.ref,
    baseSha: expected.base.sha, baseRef: expected.base.ref,
  }, async () => matches(await livePull()));
  return outcome.kind === 'updating' ? { kind: 'updating', number: expected.number } : outcome;
}
