/**
 * The GitHub payloads the controllers read.
 *
 * Every field is optional. These objects arrive from the API or from a webhook
 * event and nothing guarantees their shape, which is why the controllers reach
 * into them with `?.` and validate before acting. Declaring them optional keeps
 * that discipline visible to the compiler: the useful thing a type buys here is
 * not "this field is a string" but "this field exists at all", so a misspelt
 * property is an error instead of a silent `undefined` that fails a comparison.
 *
 * REST payloads are snake_case and GraphQL payloads are camelCase; they are
 * separate interfaces because a controller that mixes them is a real bug.
 */

export interface Actor {
  readonly login?: string;
  readonly id?: number;
  readonly type?: string;
}

export interface GitUser {
  readonly name?: string;
  readonly email?: string;
  readonly date?: string;
}

export interface CommitVerification {
  readonly verified?: boolean;
  readonly reason?: string;
}

export interface CommitDetail {
  readonly author?: GitUser;
  readonly committer?: GitUser;
  readonly message?: string;
  readonly verification?: CommitVerification;
}

export interface Commit {
  readonly sha?: string;
  readonly commit?: CommitDetail;
  readonly parents?: readonly { readonly sha?: string }[];
  readonly author?: Actor;
  readonly committer?: Actor;
}

/** One entry of a comparison's file inventory. */
export interface ComparisonFile {
  readonly filename?: string;
  readonly previous_filename?: string;
  readonly status?: string;
  readonly sha?: string;
  readonly additions?: number;
  readonly deletions?: number;
  readonly changes?: number;
  readonly patch?: string;
}

/** `GET /repos/{owner}/{repo}/compare/{basehead}`. */
export interface Comparison {
  readonly status?: string;
  readonly merge_base_commit?: { readonly sha?: string };
  readonly files?: readonly ComparisonFile[];
}

export interface Repository {
  readonly full_name?: string;
  readonly default_branch?: string;
}

export interface GitReference {
  readonly ref?: string;
  readonly sha?: string;
  readonly repo?: Repository;
}

/** A pull request as the REST API and webhook payloads spell it. */
export interface RestPullRequest {
  readonly number?: number;
  readonly node_id?: string;
  readonly state?: string;
  readonly draft?: boolean;
  readonly head?: GitReference;
  readonly base?: GitReference;
  readonly user?: Actor;
  readonly labels?: readonly { readonly name?: string }[];
  readonly auto_merge?: { readonly enabled_by?: Actor; readonly merge_method?: string } | null;
  readonly updated_at?: string;
  readonly mergeable_state?: string;
  readonly changed_files?: number;
  readonly commits?: number;
  readonly merge_commit_sha?: string;
  readonly pull_request?: unknown;
}

/**
 * A pull request the controller already resolved through the API.
 *
 * The mutation paths build branch and compare URLs straight out of `head` and
 * `base`, so for them those refs are a precondition rather than something to
 * re-derive: a pull request without them is not routable and the entry points
 * reject it before calling in. Everything else stays optional, and every SHA
 * read out of these refs is still pattern-checked before it is acted on.
 */
export interface ResolvedPullRequest extends RestPullRequest {
  readonly number: number;
  readonly head: GitReference & { readonly ref: string; readonly sha: string };
  readonly base: GitReference & { readonly ref: string; readonly sha: string };
}

/** One entry of an issue's REST timeline. */
export interface IssueTimelineEvent {
  readonly event?: string;
  readonly commit_id?: string;
  readonly after_commit?: { readonly sha?: string };
  readonly actor?: Actor;
}

export interface ComparisonFile {
  readonly filename?: string;
  readonly previous_filename?: string;
  readonly status?: string;
  readonly sha?: string;
  readonly patch?: string;
}

/** A commit comparison, which the controllers read for lineage and patches. */
export interface Comparison {
  readonly status?: string;
  readonly files?: readonly ComparisonFile[];
  readonly merge_base_commit?: { readonly sha?: string };
}

export interface WorkflowRun {
  readonly id?: number;
  readonly name?: string;
  readonly status?: string;
  readonly conclusion?: string;
  readonly event?: string;
  readonly head_sha?: string;
  readonly head_branch?: string;
  readonly run_attempt?: number;
  readonly created_at?: string;
  readonly actor?: Actor;
  readonly pull_requests?: readonly RestPullRequest[];
}

export interface WorkflowJob {
  readonly id?: number;
  readonly name?: string;
  readonly status?: string;
  readonly conclusion?: string;
  readonly run_id?: number;
  readonly run_attempt?: number;
  readonly head_sha?: string;
  readonly started_at?: string | null;
  readonly completed_at?: string | null;
  readonly runner_id?: number | null;
  readonly steps?: readonly { readonly name?: string; readonly number?: number; readonly conclusion?: string }[];
}

export interface WorkflowRunListing {
  readonly total_count?: number;
  readonly workflow_runs?: readonly WorkflowRun[];
}

export interface WorkflowJobListing {
  readonly total_count?: number;
  readonly jobs?: readonly WorkflowJob[];
}

/** One entry of an issue or pull request timeline. */
export interface TimelineEvent {
  readonly event?: string;
  readonly created_at?: string;
}

export interface IssueComment {
  readonly id?: number;
  readonly body?: string;
  readonly user?: Actor;
  readonly updated_at?: string;
  readonly created_at?: string;
  readonly issue?: { readonly number?: number; readonly pull_request?: unknown };
}

export interface Review {
  readonly id?: number;
  readonly body?: string;
  readonly state?: string;
  readonly commit_id?: string;
  readonly user?: Actor;
  readonly submitted_at?: string;
}

export interface CommitStatus {
  readonly id?: number;
  readonly context?: string;
  readonly state?: string;
  readonly sha?: string;
  readonly target_url?: string;
  readonly description?: string;
  readonly created_at?: string;
  readonly creator?: Actor;
}

export interface CheckRun {
  readonly id?: number;
  readonly name?: string;
  readonly conclusion?: string | null;
  readonly external_id?: string | null;
  readonly details_url?: string | null;
  readonly created_at?: string;
  readonly started_at?: string | null;
  readonly completed_at?: string | null;
  readonly app?: { readonly slug?: string };
}

/** The webhook event body, whichever event delivered it. */
export interface EventPayload {
  readonly action?: string;
  readonly before?: string;
  readonly sha?: string;
  readonly context?: string;
  readonly pull_request?: RestPullRequest;
  readonly workflow_run?: WorkflowRun;
  readonly review?: Review;
  readonly comment?: IssueComment;
  readonly issue?: { readonly number?: number; readonly pull_request?: unknown };
  readonly sender?: Actor;
  readonly changes?: { readonly base?: { readonly ref?: { readonly from?: string } } };
  readonly client_payload?: Record<string, unknown>;
  readonly repository?: Repository;
}

/**
 * Any REST body a controller reads back. The endpoint decides which of these
 * fields arrive and a request path tells the compiler nothing, so one shape
 * carries them all and stays entirely optional for the same reason the
 * individual payloads do.
 */
export interface GitHubJson
  extends Commit, Comparison, RestPullRequest, WorkflowRunListing, WorkflowJobListing {
  readonly truncated?: boolean;
  readonly tree?: readonly { readonly path?: string; readonly type?: string; readonly sha?: string; readonly mode?: string }[];
  readonly encoding?: string;
  readonly content?: string;
  readonly size?: number;
}

/** The REST reader a controller injects so tests can serve recorded payloads. */
export type GitHubJsonReader = (path: string, token: string | undefined) => Promise<GitHubJson>;

/** A pull request as GraphQL spells it. */
export interface GraphQlPullRequest {
  readonly number?: number;
  readonly state?: string;
  readonly isDraft?: boolean;
  readonly headRefOid?: string;
  readonly baseRefName?: string;
  readonly autoMergeRequest?: { readonly enabledBy?: { readonly login?: string } } | null;
  readonly labels?: { readonly nodes?: readonly { readonly name?: string }[] };
  readonly reviewThreads?: { readonly nodes?: readonly GraphQlReviewThread[] };
  readonly timelineItems?: { readonly nodes?: readonly Record<string, unknown>[] };
  readonly comments?: { readonly nodes?: readonly GraphQlComment[] };
}

/**
 * A GraphQL actor. A user account may carry any login, so `__typename` is the
 * only trustworthy provenance signal and the controllers compare both.
 */
export interface GraphQlActor {
  readonly __typename?: string;
  readonly login?: string;
  readonly id?: string;
}

/**
 * A pull request comment as the review controllers read it: GraphQL's own
 * fields plus the REST-shaped `user` the controller normalizes onto it, so one
 * object carries both the author provenance and the edit provenance.
 */
export interface ReviewComment {
  readonly databaseId?: number;
  readonly body?: string;
  readonly updatedAt?: string;
  readonly lastEditedAt?: string | null;
  readonly author?: GraphQlActor;
  readonly editor?: GraphQlActor | null;
  readonly userContentEdits?: {
    readonly nodes?: readonly { readonly editor?: GraphQlActor }[];
    readonly pageInfo?: { readonly hasNextPage?: boolean };
  };
  readonly user?: { readonly login?: string | null };
}

/** A pull request reaction, normalized the same way as a review comment. */
export interface ReviewReaction {
  readonly content?: string;
  readonly createdAt?: string;
  readonly user?: { readonly login?: string | null };
}

export interface GraphQlComment {
  readonly databaseId?: number;
  readonly body?: string;
  readonly author?: { readonly __typename?: string; readonly login?: string; readonly id?: string };
  readonly editor?: { readonly login?: string } | null;
  readonly lastEditedAt?: string | null;
  readonly updatedAt?: string;
  readonly userContentEdits?: { readonly nodes?: readonly { readonly editor?: { readonly login?: string } }[] };
}

export interface GraphQlReviewThread {
  readonly isResolved?: boolean;
  readonly isOutdated?: boolean;
  readonly comments?: { readonly nodes?: readonly GraphQlComment[] };
}
