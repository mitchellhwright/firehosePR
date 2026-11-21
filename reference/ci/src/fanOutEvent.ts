import { z } from 'zod';

const sha = z.string().regex(/^[0-9a-f]{40}$/);

interface FanOutMovement {
  readonly baseBranch: string;
  readonly before: string;
  readonly after: string;
}

/**
 * How the controller decides which base changes a candidate pull request has
 * not received.
 *
 * `event-range`: every candidate is judged against the pushed `before..after`.
 * Each protected-base push has its own concurrency group, so no push event is
 * ever replaced and the union of the event ranges is the whole history.
 *
 * `pending-base`: synchronize runs share one per-PR concurrency group in which
 * GitHub replaces a pending run with a newer one, so the surviving event's own
 * `before` is not a safe lower bound: after `A->B` is replaced by `B->C`,
 * `B..C` omits everything in `A..B`. Each currently eligible stacked child is
 * instead judged against `merge-base(child head, after)..after` — exactly what
 * Update Branch would merge into it. That range comes from the child itself,
 * so it covers replaced, crashed and retried events, children opened or marked
 * ready after earlier source pushes, and accepted updates that never landed.
 *
 * The cost is repetition. A child that shares a file with its pending range
 * but has not merged the source — because its update conflicted, failed, was
 * accepted and never landed, or was withheld because native checks already
 * validated its merge ref — is selected again on each later source push, even
 * when that push alone touches nothing it has. Each repeat costs at most one
 * Update Branch call per child per source push; one that lands moves the
 * merge base to `after` and ends it. A conflict repeats its warning until the
 * author resolves it.
 */
export type FanOutChange =
  | (FanOutMovement & { readonly reconciliation: 'event-range' })
  | (FanOutMovement & { readonly reconciliation: 'pending-base'; readonly sourcePullRequest: number });

export type PendingBaseChange = Extract<FanOutChange, { reconciliation: 'pending-base' }>;

/** Resolve the moved branch from the exact GitHub event, never the workflow ref. */
export function resolveFanOutChange(eventName: string, payload: unknown, repository: string): FanOutChange {
  if (eventName === 'push') {
    const event = z.object({
      ref: z.string().startsWith('refs/heads/'),
      before: sha,
      after: sha,
      repository: z.object({ full_name: z.string() }),
    }).parse(payload);
    if (event.repository.full_name !== repository) throw new Error('Push repository does not match this workflow');
    return {
      baseBranch: event.ref.slice('refs/heads/'.length),
      before: event.before,
      after: event.after,
      reconciliation: 'event-range',
    };
  }

  if (eventName === 'pull_request_target') {
    const event = z.object({
      action: z.literal('synchronize'),
      before: sha,
      after: sha,
      pull_request: z.object({
        number: z.number().int().positive(),
        head: z.object({
          ref: z.string().min(1),
          sha,
          repo: z.object({ full_name: z.string() }),
        }),
      }),
    }).parse(payload);
    if (event.pull_request.head.repo.full_name !== repository) {
      throw new Error('Pull request head repository does not match this workflow');
    }
    if (event.after !== event.pull_request.head.sha) {
      throw new Error('Synchronized pull request head does not match event after SHA');
    }
    return {
      baseBranch: event.pull_request.head.ref,
      before: event.before,
      after: event.after,
      reconciliation: 'pending-base',
      sourcePullRequest: event.pull_request.number,
    };
  }

  throw new Error(`Unsupported fan-out event: ${eventName}`);
}

const liveSourceSchema = z.object({
  state: z.string(),
  head: z.object({
    sha: z.string(),
    ref: z.string(),
    repo: z.object({ full_name: z.string() }).nullable(),
  }),
});

/**
 * Why this synchronize must not mutate anything, or `null` when it is still
 * the source PR's current tip. A newer push has its own synchronize waiting in
 * the same per-PR group and reconciles cumulatively, so an obsolete run only
 * steps aside. `branchTip` is the live `refs/heads/<source>` target, or `null`
 * when the branch no longer exists.
 */
export function staleSourceReason(
  change: PendingBaseChange,
  repository: string,
  livePull: unknown,
  branchTip: string | null,
): string | null {
  const live = liveSourceSchema.parse(livePull);
  if (live.state !== 'open') return `source pull request #${change.sourcePullRequest} is ${live.state}`;
  if (live.head.repo?.full_name !== repository || live.head.ref !== change.baseBranch) {
    return `source pull request #${change.sourcePullRequest} no longer heads ${repository}:${change.baseBranch}`;
  }
  if (live.head.sha !== change.after) {
    return `source pull request #${change.sourcePullRequest} moved to ${live.head.sha}`;
  }
  if (branchTip === null) return `branch ${change.baseBranch} was deleted`;
  if (branchTip !== change.after) return `branch ${change.baseBranch} moved to ${branchTip}`;
  return null;
}

const liveChildSchema = z.object({
  state: z.string(),
  base: z.object({ ref: z.string() }),
  head: z.object({ sha: z.string() }),
});

/** Why a selected child must not be updated now, or `null` when it is still the judged tuple. */
export function staleChildReason(baseBranch: string, judgedHeadSha: string, liveChild: unknown): string | null {
  const live = liveChildSchema.parse(liveChild);
  if (live.state !== 'open') return `it is ${live.state}`;
  if (live.base.ref !== baseBranch) return `it now targets ${live.base.ref}`;
  if (live.head.sha !== judgedHeadSha) return `its head moved to ${live.head.sha}`;
  return null;
}

export type ChildUpdateAdmission =
  | { readonly kind: 'current' }
  | { readonly kind: 'moved'; readonly reason: string }
  | { readonly kind: 'incoherent'; readonly reason: string };

/**
 * A PR snapshot can lag its branch ref even across repeated reads. Never scan
 * evidence or update that stale head: checks on the snapshot do not validate
 * the branch. Do not guess which SHA a native update should trust.
 * Read the live PR first so a retargeted, closed or foreign head cannot make
 * this controller inspect or mutate a branch selected from an older tuple.
 */
export async function admitChildUpdate(
  baseBranch: string,
  judgedHeadSha: string,
  repository: string,
  liveChild: unknown,
  readBranchTip: (branch: string) => Promise<string | null>,
): Promise<ChildUpdateAdmission> {
  const moved = staleChildReason(baseBranch, judgedHeadSha, liveChild);
  if (moved !== null) return { kind: 'moved', reason: moved };
  const live = z.object({ head: z.object({
    sha,
    ref: z.string().min(1),
    repo: z.object({ full_name: z.string() }).nullable(),
  }) }).parse(liveChild);
  if (live.head.repo?.full_name !== repository) {
    return { kind: 'moved', reason: 'its head no longer belongs to this repository' };
  }
  const tip = await readBranchTip(live.head.ref);
  if (tip !== null) sha.parse(tip);
  if (tip === live.head.sha) return { kind: 'current' };
  return {
    kind: 'incoherent',
    reason: `PR head ${live.head.sha} disagrees with branch ${live.head.ref} at ${tip ?? 'deleted'}. `
      + 'Reconcile the PR head with its branch before refreshing; rerunning unchanged metadata cannot repair it.',
  };
}

/** The base history one candidate is judged against. */
export interface FanOutRange {
  readonly before: string;
  readonly after: string;
}

/** The fields of `GET compare/{child head}...{source tip}` that locate the child on the source history. */
export const pendingBaseComparisonSchema = z.object({
  ahead_by: z.number().int().nonnegative(),
  merge_base_commit: z.object({ sha }),
});

/** Reads one GitHub three-dot comparison; a missing common ancestor must throw. */
export type CompareCommits = (base: string, head: string) => Promise<unknown>;

/**
 * The base range a candidate still lacks, or `null` when its head already
 * contains `after` and Update Branch has nothing to merge.
 *
 * In `pending-base` mode a force-pushed or rewritten source still resolves: the
 * merge base is the newest commit the child actually shares with the source,
 * so every rewritten change after it is inside the range. A child with no
 * common ancestor makes the comparison fail, which aborts the run before any
 * branch is updated.
 */
export async function candidateBaseRange(
  change: FanOutChange,
  candidateHeadSha: string,
  compare: CompareCommits,
): Promise<FanOutRange | null> {
  if (change.reconciliation === 'event-range') return { before: change.before, after: change.after };
  const { after } = change;
  const child = pendingBaseComparisonSchema.parse(await compare(candidateHeadSha, after));
  if (child.ahead_by === 0) return null;
  const mergeBase = child.merge_base_commit.sha;
  if (mergeBase === after) {
    throw new Error(`Comparison of ${candidateHeadSha}...${after} is ahead by `
      + `${child.ahead_by} commit(s) yet reports ${after} as the merge base.`);
  }
  return { before: mergeBase, after };
}
