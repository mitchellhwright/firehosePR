const SHA = /^[a-f0-9]{40}$/;
const REPOSITORY = 'example-org/example-app';
const DEPENDABOT_LOGIN = 'dependabot[bot]';
const DEPENDABOT_EMAIL = '49699333+dependabot[bot]@users.noreply.github.com';
const CONTROLLER_LOGIN = 'example-promotion-checkpoint[bot]';
const CONTROLLER_EMAIL = '324658254+example-promotion-checkpoint[bot]@users.noreply.github.com';

interface Actor {
  readonly login: string;
}

interface TrustedPullRequest {
  readonly number: number;
  readonly user: Actor & { readonly type: string };
  readonly head: {
    readonly ref: string;
    readonly sha: string;
    readonly repo: { readonly full_name: string };
  };
  readonly base: {
    readonly ref: string;
    readonly repo: { readonly full_name: string };
  };
}

interface TrustedComparisonFile {
  readonly filename: string;
  readonly status: string;
  readonly patch?: string;
}

interface TrustedCommit {
  readonly sha: string;
  readonly author: Actor;
  readonly committer: Actor;
  readonly parents: readonly { readonly sha: string }[];
  readonly commit: {
    readonly author: { readonly email: string };
    readonly committer: { readonly email: string };
    readonly message: string;
    readonly verification: { readonly verified: boolean; readonly reason: string };
  };
}

interface ForcePushEvent {
  readonly actor: Actor;
  readonly commit_id?: string;
  readonly after_commit?: string | { readonly sha: string };
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function nonemptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

function fullSha(value: unknown): value is string {
  return typeof value === 'string' && SHA.test(value);
}

function parseActor(value: unknown): Actor | null {
  return isRecord(value) && typeof value.login === 'string'
    ? { login: value.login }
    : null;
}

function parseRepository(value: unknown): { readonly full_name: string } | null {
  return isRecord(value) && typeof value.full_name === 'string'
    ? { full_name: value.full_name }
    : null;
}

function parsePullRequest(value: unknown): TrustedPullRequest | null {
  if (!isRecord(value) || !Number.isSafeInteger(value.number) || Number(value.number) <= 0
    || !isRecord(value.user) || !isRecord(value.head) || !isRecord(value.base)) return null;
  const user = parseActor(value.user);
  const headRepository = parseRepository(value.head.repo);
  const baseRepository = parseRepository(value.base.repo);
  if (user === null || typeof value.user.type !== 'string'
    || !nonemptyString(value.head.ref) || !fullSha(value.head.sha)
    || headRepository === null || !nonemptyString(value.base.ref) || baseRepository === null) return null;
  return {
    number: Number(value.number),
    user: { ...user, type: value.user.type },
    head: { ref: value.head.ref, sha: value.head.sha, repo: headRepository },
    base: { ref: value.base.ref, repo: baseRepository },
  };
}

function parseComparisonFiles(value: unknown): readonly TrustedComparisonFile[] | null {
  if (!Array.isArray(value) || value.length === 0) return null;
  const files: TrustedComparisonFile[] = [];
  for (const candidate of value) {
    if (!isRecord(candidate) || !nonemptyString(candidate.filename)
      || typeof candidate.status !== 'string'
      || (candidate.patch !== undefined && typeof candidate.patch !== 'string')) return null;
    files.push({
      filename: candidate.filename,
      status: candidate.status,
      ...(candidate.patch === undefined ? {} : { patch: candidate.patch }),
    });
  }
  return files;
}

function parseCommit(value: unknown): TrustedCommit | null {
  if (!isRecord(value) || !fullSha(value.sha) || !Array.isArray(value.parents)
    || !isRecord(value.commit)) return null;
  const author = parseActor(value.author);
  const committer = parseActor(value.committer);
  if (author === null || committer === null || !isRecord(value.commit.author)
    || !isRecord(value.commit.committer) || !isRecord(value.commit.verification)
    || typeof value.commit.author.email !== 'string'
    || typeof value.commit.committer.email !== 'string'
    || typeof value.commit.message !== 'string'
    || typeof value.commit.verification.verified !== 'boolean'
    || typeof value.commit.verification.reason !== 'string') return null;
  const parents: { readonly sha: string }[] = [];
  for (const parent of value.parents) {
    if (!isRecord(parent) || !fullSha(parent.sha)) return null;
    parents.push({ sha: parent.sha });
  }
  return {
    sha: value.sha,
    author,
    committer,
    parents,
    commit: {
      author: { email: value.commit.author.email },
      committer: { email: value.commit.committer.email },
      message: value.commit.message,
      verification: {
        verified: value.commit.verification.verified,
        reason: value.commit.verification.reason,
      },
    },
  };
}

function parseCommits(value: unknown): readonly TrustedCommit[] | null {
  if (!Array.isArray(value) || value.length === 0) return null;
  const commits: TrustedCommit[] = [];
  for (const candidate of value) {
    const commit = parseCommit(candidate);
    if (commit === null) return null;
    commits.push(commit);
  }
  return commits;
}

function parseForcePushEvents(value: unknown): readonly ForcePushEvent[] | null {
  if (!Array.isArray(value)) return null;
  const events: ForcePushEvent[] = [];
  for (const candidate of value) {
    if (!isRecord(candidate)) return null;
    const actor = parseActor(candidate.actor);
    const commitId = candidate.commit_id;
    const afterCommit = candidate.after_commit;
    if (actor === null || (commitId !== undefined && !fullSha(commitId))) return null;
    let normalizedAfterCommit: ForcePushEvent['after_commit'];
    if (afterCommit === undefined) {
      normalizedAfterCommit = undefined;
    } else if (fullSha(afterCommit)) {
      normalizedAfterCommit = afterCommit;
    } else if (isRecord(afterCommit) && fullSha(afterCommit.sha)) {
      normalizedAfterCommit = { sha: afterCommit.sha };
    } else {
      return null;
    }
    events.push({
      actor,
      ...(commitId === undefined ? {} : { commit_id: commitId }),
      ...(normalizedAfterCommit === undefined ? {} : { after_commit: normalizedAfterCommit }),
    });
  }
  return events;
}

function isPackageDependencyFile(path: string): boolean {
  return /^(?:[^/]+\/)*(?:package|package-lock|npm-shrinkwrap)\.json$/.test(path)
    || /^(?:[^/]+\/)*(?:yarn|pnpm-lock)\.(?:json|ya?ml|lock)$/.test(path)
    || /^(?:[^/]+\/)*Gemfile(?:\.lock)?$/.test(path)
    || /^(?:[^/]+\/)*Package\.resolved$/.test(path);
}

function changedPatchLines(patch: string): readonly string[] {
  return patch.split('\n').filter(line => /^[+-]/.test(line) && !/^(---|\+\+\+)/.test(line));
}

function isPinnedActionUpdate(file: TrustedComparisonFile): boolean {
  if (!/^\.github\/workflows\/[^/]+\.ya?ml$/.test(file.filename)
    || typeof file.patch !== 'string') return false;
  const changed = changedPatchLines(file.patch);
  return changed.length > 0 && changed.every(line =>
    /^[+-]\s*uses:\s+[A-Za-z0-9_.-]+\/[A-Za-z0-9_./-]+@[0-9a-f]{40}\s+#\s+v[^\s]+\s*$/.test(line));
}

function isDockerImageUpdate(file: TrustedComparisonFile): boolean {
  if (!/^(?:[^/]+\/)*Dockerfile(?:\.[A-Za-z0-9_.-]+)?$/.test(file.filename)
    || typeof file.patch !== 'string') return false;
  const changed = changedPatchLines(file.patch);
  return changed.some(line => line.startsWith('-'))
    && changed.some(line => line.startsWith('+'))
    && changed.every(line => /^[+-]FROM\s+node:[^\s]+(?:\s+AS\s+[^\s]+)?\s*$/i.test(line));
}

function isDependencyOnlyFile(file: TrustedComparisonFile): boolean {
  return file.status === 'modified'
    && (isPackageDependencyFile(file.filename)
      || isPinnedActionUpdate(file)
      || isDockerImageUpdate(file));
}

function hasValidSignature(commit: TrustedCommit): boolean {
  return commit.commit.verification.verified
    && commit.commit.verification.reason === 'valid'
    && commit.committer.login === 'web-flow'
    && commit.commit.committer.email === 'noreply@github.com';
}

function isDependabotRootCommit(commit: TrustedCommit): boolean {
  return hasValidSignature(commit)
    && commit.author.login === DEPENDABOT_LOGIN
    && commit.commit.author.email === DEPENDABOT_EMAIL;
}

function isControllerBaseUpdate(
  commit: TrustedCommit,
  pullRequest: TrustedPullRequest,
  expectedFirstParent: string,
): boolean {
  const message = commit.commit.message.trimEnd();
  return hasValidSignature(commit)
    && commit.author.login === CONTROLLER_LOGIN
    && commit.commit.author.email === CONTROLLER_EMAIL
    && commit.parents.length === 2
    && commit.parents[0]?.sha === expectedFirstParent
    && (
      message === `chore: update PR #${pullRequest.number} from ${pullRequest.base.ref}`
      || message === `Merge branch '${pullRequest.base.ref}' into ${pullRequest.head.ref}`
    );
}

function forcePushTarget(event: ForcePushEvent): string | null {
  if (event.commit_id !== undefined) return event.commit_id;
  if (typeof event.after_commit === 'string') return event.after_commit;
  return event.after_commit?.sha ?? null;
}

function hasTrustedForcePushProvenance(
  events: readonly ForcePushEvent[],
  commits: readonly TrustedCommit[],
): boolean {
  // GitHub returns issue timeline events oldest first. Dependabot rebases
  // discard their prior target, so only the latest force push can describe
  // provenance for the commits that still make up the current head.
  const latest = events.at(-1);
  if (latest === undefined) return true;
  const originalHead = commits[0]?.sha;
  const controllerHeads = new Set(commits.slice(1).map(commit => commit.sha));
  const target = forcePushTarget(latest);
  return (latest.actor.login === DEPENDABOT_LOGIN && target === originalHead)
    || (latest.actor.login === CONTROLLER_LOGIN && target !== null && controllerHeads.has(target));
}

/**
 * Proves that a PR contains only a signed Dependabot dependency update plus
 * signed controller merges of its target branch. External API values are
 * parsed before any trust decision, including force-push provenance.
 */
export function isTrustedDependabotUpdate(
  pullRequestValue: unknown,
  filesValue: unknown,
  commitsValue: unknown,
  forcePushEventsValue: unknown = [],
): boolean {
  const pullRequest = parsePullRequest(pullRequestValue);
  const files = parseComparisonFiles(filesValue);
  const commits = parseCommits(commitsValue);
  const forcePushEvents = parseForcePushEvents(forcePushEventsValue);
  if (pullRequest === null || files === null || commits === null || forcePushEvents === null) return false;
  const rootCommit = commits[0];
  if (rootCommit === undefined) return false;
  if (pullRequest.user.login !== DEPENDABOT_LOGIN || pullRequest.user.type !== 'Bot'
    || pullRequest.head.repo.full_name !== REPOSITORY
    || pullRequest.base.repo.full_name !== REPOSITORY
    || !pullRequest.head.ref.startsWith('dependabot/')
    || !['develop', 'main'].includes(pullRequest.base.ref)
    || !files.every(isDependencyOnlyFile)
    || !isDependabotRootCommit(rootCommit)
    || !hasTrustedForcePushProvenance(forcePushEvents, commits)) return false;

  let expectedFirstParent = rootCommit.sha;
  for (const commit of commits.slice(1)) {
    if (!isControllerBaseUpdate(commit, pullRequest, expectedFirstParent)) return false;
    expectedFirstParent = commit.sha;
  }
  return expectedFirstParent === pullRequest.head.sha;
}


export interface DependabotEvidence {
  readonly files: readonly unknown[];
  readonly commits: readonly unknown[];
  readonly forcePushEvents: readonly unknown[];
}

/** Read every page; incomplete or malformed evidence cannot authorize auto-merge. */
export async function loadDependabotEvidence(
  prNumber: number,
  fetch: (path: string) => Promise<unknown>,
): Promise<DependabotEvidence> {
  if (!Number.isSafeInteger(prNumber) || prNumber <= 0) throw new Error('Invalid PR number');
  const pages = async (path: string, limit: number): Promise<readonly unknown[]> => {
    const items: unknown[] = [];
    for (let page = 1; page <= 30; page += 1) {
      const result = await fetch(`${path}?per_page=100&page=${page}`);
      if (!Array.isArray(result)) throw new Error(`Invalid GitHub evidence: ${path}`);
      items.push(...result);
      // REST caps PR files at 3000 and commits at 250. At the cap we cannot
      // distinguish complete evidence from truncation, so do not authorize it.
      if (items.length >= limit) throw new Error(`Incomplete GitHub evidence: ${path}`);
      if (result.length < 100) return items;
    }
    throw new Error(`Incomplete GitHub evidence: ${path}`);
  };
  const [files, commits, timeline] = await Promise.all([
    pages(`pulls/${prNumber}/files`, 3000),
    pages(`pulls/${prNumber}/commits`, 250),
    pages(`issues/${prNumber}/timeline`, 3000),
  ]);
  const forcePushEvents: unknown[] = [];
  for (const event of timeline) {
    if (!isRecord(event) || typeof event.event !== 'string') throw new Error('Invalid GitHub timeline evidence');
    if (event.event === 'head_ref_force_pushed') forcePushEvents.push(event);
  }
  return { files, commits, forcePushEvents };
}
