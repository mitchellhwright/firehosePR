import { planningNamePattern } from './prValidationPlanning.ts';
import { isGeneratedArtifactPath } from './generatedArtifactPath.ts';
import { classifyIosChangedPaths } from './ios/iosChangeClassification.ts';
import { isIosEvidenceInvalidatingInput } from './ios/iosExecutionInputs.ts';
import { z } from 'zod';

/**
 * After a push to a protected base, decide which open pull requests need
 * their branch updated now rather than whenever someone looks.
 *
 * `develop` does not require an up-to-date branch and no longer has a merge
 * queue to validate a new integration candidate. Its adapter updates only
 * pull requests with selected native iOS work when a base push changes an
 * input in their compiled product. Other overlaps are reported if they
 * conflict. On `main` and on a stacked child's parent branch a pull request
 * is still updated when it
 * shares a file with the push, when a shared CI repair matches one of its
 * failed checks, when a retired workflow left a check run nothing can
 * supersede, or when its head lacks a newly required workflow executable.
 * Verified base-update paths reuse unaffected evidence, including iOS work.
 */

export const openPullRequestSchema = z.object({
  number: z.number().int().positive(),
  draft: z.boolean(),
  authorLogin: z.string().min(1),
  headRepositoryFullName: z.string(),
  headSha: z.string().regex(/^[0-9a-f]{40}$/),
  files: z.array(z.string()),
  failedChecks: z.array(z.string()).optional(),
  missingWorkflowRuntimeFiles: z.array(z.string()).optional(),
});
export type OpenPullRequest = z.infer<typeof openPullRequestSchema>;

const shaSchema = z.string().regex(/^[0-9a-f]{40}$/);

/**
 * The two native pull-request workflows that together validate every Example
 * integration candidate. Both are dispatched for every ready pull request;
 * their own typed planners decide which Linux, database and iOS lanes run.
 */
export const nativeIntegrationWorkflowNames = ['PR Checks', 'Test - iOS'] as const;
export const nativeIntegrationWorkflowNameSchema = z.enum(nativeIntegrationWorkflowNames);
export type NativeIntegrationWorkflowName = z.infer<typeof nativeIntegrationWorkflowNameSchema>;

/** The immutable workflow-run fields used to prove which base a head validated. */
export const nativeIntegrationRunSchema = z.object({
  id: z.number().int().positive(),
  name: z.string(),
  event: z.string(),
  head_sha: shaSchema,
  created_at: z.iso.datetime({ offset: true }),
  status: z.string(),
  conclusion: z.string().nullable(),
  pull_requests: z.array(z.object({
    number: z.number().int().positive(),
  })),
});
export type NativeIntegrationRun = z.infer<typeof nativeIntegrationRunSchema>;

export const nativeIntegrationJobSchema = z.object({
  name: z.string(),
  status: z.string(),
  conclusion: z.string().nullable(),
});
export type NativeIntegrationJob = z.infer<typeof nativeIntegrationJobSchema>;
export type NativeIntegrationRunWithJobs = NativeIntegrationRun & { readonly jobs: readonly NativeIntegrationJob[] };

export const pullRequestTimelineEventSchema = z.object({
  event: z.string(),
  created_at: z.string().nullish(),
});
export type PullRequestTimelineEvent = z.infer<typeof pullRequestTimelineEventSchema>;

/** A missing or malformed timeline cannot prove that the PR stayed on this base. */
export function latestBaseRetargetAt(events: readonly PullRequestTimelineEvent[]): string | null {
  if (events.length === 0) throw new Error('Missing pull request timeline evidence');
  let latest: string | null = null;
  for (const event of events) {
    if (event.event !== 'base_ref_changed') continue;
    const changedAt = z.iso.datetime({ offset: true }).parse(event.created_at);
    if (latest === null || Date.parse(changedAt) > Date.parse(latest)) latest = changedAt;
  }
  return latest;
}

const integrationGateNames: Record<NativeIntegrationWorkflowName, RegExp> = {
  'PR Checks': planningNamePattern,
  'Test - iOS': /^iOS Change Gate$/,
};

export function candidateNativeIntegrationWorkflow(
  pullRequestNumber: number,
  headSha: string,
  baseUpdateTime: number,
  run: NativeIntegrationRun,
): NativeIntegrationWorkflowName | null {
  // GitHub timestamps have second precision. Equal timestamps cannot prove
  // whether this run received its merge ref before or after the base push.
  if (run.event !== 'pull_request' || run.head_sha !== headSha || Date.parse(run.created_at) <= baseUpdateTime) return null;
  const workflow = nativeIntegrationWorkflowNameSchema.safeParse(run.name);
  if (!workflow.success || !run.pull_requests.some((pullRequest) => pullRequest.number === pullRequestNumber)) return null;
  return workflow.data;
}

function startedIntegrationGate(workflow: NativeIntegrationWorkflowName, jobs: readonly NativeIntegrationJob[]): boolean {
  return jobs.some((job) => integrationGateNames[workflow].test(job.name)
    && (job.status === 'in_progress'
      || (job.status === 'completed' && job.conclusion !== null
        && !['skipped', 'cancelled'].includes(job.conclusion))));
}

export interface NativeIntegrationEvidence {
  readonly complete: boolean;
  readonly workflows: readonly NativeIntegrationWorkflowName[];
}

/**
 * Decide whether GitHub has already created the current head/base integration
 * candidate. Workflow-run `head_sha` and `created_at` are immutable. A run
 * created strictly after the base-push controller run received its merge ref
 * after that push and after the latest base retarget. Tied timestamps are
 * ambiguous because GitHub records only whole seconds. An unrelated PR metadata
 * edit can create the same pair of runs while both integration gates skip.
 * Require a gate that actually started
 * before retaining the head. We use the PR's immutable retarget timeline to
 * reject runs started on another base. We do not trust `pull_requests[].base.sha`:
 * GitHub rewrites that field on historical runs to the PR's current base.
 * A running gate or a gate that completed validation counts even when the
 * overall workflow later fails. Rewriting then would invalidate that candidate.
 */
export function nativeIntegrationEvidence(
  pullRequestNumber: number,
  headSha: string,
  baseUpdateRunCreatedAt: string,
  runs: readonly NativeIntegrationRunWithJobs[],
  latestRetargetAt: string | null = null,
): NativeIntegrationEvidence {
  const baseUpdateTime = Date.parse(z.iso.datetime({ offset: true }).parse(baseUpdateRunCreatedAt));
  const retargetTime = latestRetargetAt === null
    ? 0 : Date.parse(z.iso.datetime({ offset: true }).parse(latestRetargetAt));
  const evidenceCutoff = Math.max(baseUpdateTime, retargetTime);
  const required = new Set<string>(nativeIntegrationWorkflowNames);
  const observed = new Set<NativeIntegrationWorkflowName>();
  for (const run of runs) {
    const workflow = candidateNativeIntegrationWorkflow(pullRequestNumber, headSha, evidenceCutoff, run);
    if (workflow !== null && startedIntegrationGate(workflow, run.jobs)) observed.add(workflow);
  }
  const workflows = nativeIntegrationWorkflowNames.filter((name) => observed.has(name));
  return {
    complete: workflows.length === required.size,
    workflows,
  };
}

export interface FanoutDecision {
  readonly number: number;
  readonly headSha: string;
  readonly overlap: readonly string[];
  /** Base inputs that change the native iOS product this PR must validate. */
  readonly iosBaseImpact?: readonly string[];
  /** Failed checks selected because this push repairs their shared CI path. */
  readonly repairedChecks?: readonly string[];
  /** Set when the push deleted a workflow, so the reason is visible in the summary. */
  readonly retiredWorkflows?: readonly string[];
  /** Newly required workflow executables absent from this PR's exact head. */
  readonly missingWorkflowRuntimeFiles?: readonly string[];
}

/**
 * Whether ordinary overlap, CI repair, retirement or missing-executable
 * selection may merge the base into an open pull request. Native iOS product
 * invalidation is a separate, narrower develop exception.
 *
 * `develop` does not require branches to be up to date. Ordinary overlaps
 * remain report-only so a documentation edit cannot restart a fleet of PRs.
 * A native iOS input change is different: it changes the product an iOS PR
 * would merge, so the selected heads need a new integration candidate.
 * `main` requires up-to-date branches, and a stacked child's base is its
 * parent pull request's branch; both use ordinary overlap updates.
 */
export function mergesBaseIntoPullRequests(baseBranch: string): boolean {
  return baseBranch !== 'develop';
}

export interface ReportOnlyOverlap {
  readonly number: number;
  readonly headSha: string;
  readonly files: readonly string[];
}

/**
 * Pull requests whose overlap with the push is checked for a merge conflict
 * instead of being merged: every overlap on a base that does not require an
 * up-to-date branch, and elsewhere an overlap made only of generated output.
 */
export function reportOnlyOverlaps(
  repository: string,
  baseBranch: string,
  pushedFiles: readonly string[],
  pullRequests: readonly OpenPullRequest[],
): ReportOnlyOverlap[] {
  const pushed = new Set(pushedFiles);
  const mergesOverlap = mergesBaseIntoPullRequests(baseBranch);
  return pullRequests.flatMap((pullRequest) => {
    if (!mayBeSelected(pullRequest, repository, false)) return [];
    const overlap = pullRequest.files.filter((file) => pushed.has(file));
    if (overlap.length === 0) return [];
    if (mergesOverlap && overlap.some((file) => !isGeneratedArtifactPath(file))) return [];
    return [{ number: pullRequest.number, headSha: pullRequest.headSha, files: overlap.sort() }];
  });
}

const mergeQueueResponseSchema = z.object({
  data: z.object({
    repository: z.object({
      mergeQueue: z.object({
        entries: z.object({
          totalCount: z.number().int().nonnegative(),
          nodes: z.array(z.object({ pullRequest: z.object({ number: z.number().int().positive() }).nullable() })),
        }),
      }).nullable(),
    }),
  }),
});

/** The GraphQL query whose answer `mergeQueuePullRequests` reads. */
export const MERGE_QUEUE_QUERY = 'query($owner:String!,$name:String!,$branch:String!){'
  + 'repository(owner:$owner,name:$name){mergeQueue(branch:$branch){'
  + 'entries(first:100){totalCount nodes{pullRequest{number}}}}}}';

/**
 * Pull requests waiting in the base branch's merge queue. The queue builds
 * each one on the latest base and removes it itself when it conflicts, so the
 * base-update controller leaves queued pull requests alone. A base without a
 * queue answers `null`. A partial answer would silently drop entries, so a
 * queue longer than one page is an error rather than a guess.
 */
export function mergeQueuePullRequests(response: unknown): ReadonlySet<number> {
  const parsed = mergeQueueResponseSchema.safeParse(response);
  // GraphQL can answer `mergeQueue: null` beside an error, which would read
  // as "no queue" and let this controller act on queued pull requests.
  const errors = z.object({ errors: z.array(z.unknown()).min(1) }).safeParse(response);
  if (!parsed.success || errors.success) {
    throw new Error(`Unexpected merge queue response: ${JSON.stringify(response).slice(0, 500)}`);
  }
  const queue = parsed.data.data.repository.mergeQueue;
  if (queue === null) return new Set();
  if (queue.entries.totalCount > queue.entries.nodes.length) {
    throw new Error(`The merge queue holds ${queue.entries.totalCount} entries; only ${queue.entries.nodes.length} were read.`);
  }
  return new Set(queue.entries.nodes.flatMap((node) => node.pullRequest === null ? [] : [node.pullRequest.number]));
}

export function overlapMergeability(
  mergeable: boolean | null,
  state: string,
): 'conflict' | 'clean' | 'unknown' {
  if (mergeable === false && state === 'dirty') return 'conflict';
  if (mergeable === true) return 'clean';
  return 'unknown';
}

const PR_CHECKS = [
  planningNamePattern,
  /^Evaluate PR validation policy$/,
  /^Resolve PR Linux runner$/,
  /^Lint changed code$/,
  /^Server static validation$/,
  /^Workflow contracts$/,
  /^Server tests \([1-4]\/4\)$/,
  /^Server process-heavy tests$/,
  /^Run database integration tests$/,
  /^Targeted server tests$/,
  /^iOS-server contracts$/,
  /^Validate pull request changes$/,
] as const;

const SERVER_TEST_CHECKS = [
  /^Server tests \([1-4]\/4\)$/,
  /^Server process-heavy tests$/,
  /^Run database integration tests$/,
  /^Targeted server tests$/,
  /^Validate pull request changes$/,
] as const;

/**
 * Return the failed check names a protected-base push can repair for existing
 * pull requests. These rules are deliberately narrow: a base update must not
 * wake an unrelated successful iOS tuple or retry a product failure merely
 * because some CI file changed.
 */
export function repairableFailedChecks(
  pushedFiles: readonly string[],
  failedChecks: readonly string[],
): string[] {
  const repairsPrChecks = pushedFiles.some((file) =>
    file === 'ci/src/prValidationPlan.ts'
    || file === 'ci/workflows/pr-checks.ts'
    || file === '.github/workflows/pr-checks.yml');
  const repairsContinuity = pushedFiles.some((file) =>
    file === 'ci/src/baseUpdateFanout.ts'
    || file === 'ci/src/actions/refreshOverlappingPullRequests.ts'
    || file === 'ci/src/retargetRecovery.ts'
    || file === 'ci/src/pinnedBaseGithub.ts'
    || file === 'ci/src/pinnedBaseUpdate.ts'
    || file === 'ci/workflows/refresh-pr-ci-after-base-edit.ts'
    || file === '.github/workflows/refresh-pr-ci-after-base-edit.yml');
  const repairsServerTests = pushedFiles.some((file) =>
    /^server\/tests\/.*(?:contract|migration).*\.test\.ts$/i.test(file)
    || /^scripts\/(?:ci|tests)\/.*(?:server|contract|migration)/i.test(file));

  const patterns = [
    ...(repairsPrChecks ? PR_CHECKS : []),
    ...(repairsContinuity ? [/^Keep PR work current$/] : []),
    ...(repairsServerTests ? SERVER_TEST_CHECKS : []),
  ];
  if (patterns.length === 0) return [];
  return [...new Set(failedChecks.filter((name) => patterns.some((pattern) => pattern.test(name))))].sort();
}

export function hasRepairableCheckScope(pushedFiles: readonly string[]): boolean {
  return repairableFailedChecks(pushedFiles, ['Validate pull request changes', 'Keep PR work current']).length > 0;
}

/**
 * A check run stays on the head that produced it forever, and only the
 * workflow that wrote it can ever supersede it. Delete that workflow and every
 * eligible pull request keeps its last result — a cancelled or failed one included
 * — with nothing able to replace it. GitHub counts it in the merge box's
 * rollup, so those pull requests are blocked permanently by a workflow that no
 * longer exists, and no rerun, review or approval clears it. Only a new head
 * does.
 *
 * A pull request in that state overlaps no pushed file, so the overlap rule
 * alone never reaches it. Deleting a workflow therefore selects every eligible
 * open non-Dependabot pull request: the deletion is rare, and the alternative
 * is a fleet that silently cannot merge. Dependabot owns its own head and must
 * recreate it rather than receive a generic base-update merge commit.
 *
 * Drafts are included on this path alone. An ordinary push leaves a draft to
 * its author, but a draft that was ready earlier already carries the dead
 * check run, and marking it ready does not change the head — so without this
 * it would be handed back to its author permanently blocked.
 */
export function retiredWorkflowPaths(deletedFiles: readonly string[]): string[] {
  return deletedFiles
    .filter((file) => /^\.github\/workflows\/[^/]+\.ya?ml$/.test(file))
    .sort();
}

/**
 * Whether this pull request can be selected at all, decided from what is known
 * before its file list is read. A fork head is never updatable with this
 * token, and an ordinary push leaves a draft to its author.
 *
 * The caller uses this to avoid enumerating files it cannot act on, so the
 * rule stays here rather than being restated at the call site and drifting.
 */
export function mayBeSelected(
  pullRequest: Pick<OpenPullRequest, 'draft' | 'authorLogin' | 'headRepositoryFullName'>,
  repository: string,
  retiring: boolean,
): boolean {
  // Dependabot owns its branch lifecycle. Updating its head through GitHub's
  // generic Update Branch endpoint creates a non-Dependabot merge commit,
  // after which Dependabot refuses its own rebase/recreate workflow.
  return pullRequest.authorLogin !== 'dependabot[bot]'
    && pullRequest.headRepositoryFullName === repository
    && (retiring || !pullRequest.draft);
}

export function selectPullRequestsToUpdate(
  repository: string,
  baseBranch: string,
  pushedFiles: readonly string[],
  pullRequests: readonly OpenPullRequest[],
  retiredWorkflows: readonly string[] = [],
): FanoutDecision[] {
  const develop = baseBranch === 'develop';
  const iosBaseImpact = develop ? pushedFiles.filter(isIosEvidenceInvalidatingInput) : [];
  if (develop && iosBaseImpact.length === 0) return [];
  // Generated bundles fan in independent API and Swift sources. Their shared
  // path alone does not mean a PR needs to discard its passed checks; GitHub
  // mergeability still exposes a genuine generated-output conflict.
  const pushed = new Set(pushedFiles.filter((file) => !isGeneratedArtifactPath(file)));
  const decisions: FanoutDecision[] = [];
  const retiring = retiredWorkflows.length > 0;
  for (const pullRequest of pullRequests) {
    if (!mayBeSelected(pullRequest, repository, retiring)) continue;
    const overlap = pullRequest.files.filter((file) => pushed.has(file)).sort();
    const repairedChecks = repairableFailedChecks(pushedFiles, pullRequest.failedChecks ?? []);
    const missingRuntime = pullRequest.missingWorkflowRuntimeFiles ?? [];
    const impactsIosProduct = iosBaseImpact.length > 0
      && classifyIosChangedPaths(pullRequest.files).iosChangedFiles.length > 0;
    if (develop && !impactsIosProduct) continue;
    if (!develop && !retiring && overlap.length === 0 && repairedChecks.length === 0 && missingRuntime.length === 0) continue;
    decisions.push({
      number: pullRequest.number,
      headSha: pullRequest.headSha,
      overlap,
      ...(impactsIosProduct ? { iosBaseImpact } : {}),
      ...(repairedChecks.length > 0 ? { repairedChecks } : {}),
      ...(retiring ? { retiredWorkflows: [...retiredWorkflows] } : {}),
      ...(missingRuntime.length > 0 ? { missingWorkflowRuntimeFiles: [...missingRuntime] } : {}),
    });
  }
  return decisions.sort((left, right) => left.number - right.number);
}

/** GitHub's Update Branch responses, reduced to what the caller reports. */
export type UpdateBranchOutcome =
  | { readonly kind: 'updating' }
  | { readonly kind: 'conflict' }
  | { readonly kind: 'already-current' }
  | { readonly kind: 'error'; readonly status: number; readonly message: string };

export function classifyUpdateBranchResponse(status: number, body: string): UpdateBranchOutcome {
  if (status === 202) return { kind: 'updating' };
  let message = body;
  try {
    const parsed: unknown = JSON.parse(body);
    if (parsed && typeof parsed === 'object' && 'message' in parsed && typeof parsed.message === 'string') {
      message = parsed.message;
    }
  } catch {
    // A non-JSON body is reported verbatim.
  }
  if (status === 422 && /merge conflict|not mergeable|cannot be updated/i.test(message)) return { kind: 'conflict' };
  if (status === 422 && /already up to date|no new commits/i.test(message)) return { kind: 'already-current' };
  return { kind: 'error', status, message };
}
