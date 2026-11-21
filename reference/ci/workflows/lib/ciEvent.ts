import { expr, type ExpressionValue } from 'gagen';
import { SUPPORTED_CI_EVENTS, type SupportedCiEvent } from '../../src/ciEvent.ts';
import { MERGE_QUEUE_BASE_BRANCH, MERGE_QUEUE_BASE_REF } from '../../src/mergeQueueRef.ts';

/**
 * The one place a required workflow reads event-derived tuple fields.
 *
 * `pull_request`, `merge_group` and `workflow_dispatch` carry the head under
 * test and the trusted base in different payload fields, and the obvious
 * `github.event.pull_request.base.sha || github.sha` idiom silently resolves
 * to the merge queue candidate on `merge_group` — running candidate code as
 * the trusted verifier. Every field here is therefore a table with one entry
 * per supported event (the mapped type makes a missing entry a compile error),
 * rendered as an explicit per-event selection that never falls through from
 * one event's value to another's.
 *
 * `ci/tests/mergeGroupWorkflows.test.ts` refuses a raw payload read in the
 * required workflows' sources, so a new tuple field has to be added here.
 */

export { SUPPORTED_CI_EVENTS, type SupportedCiEvent } from '../../src/ciEvent.ts';

type PerCiEvent<T> = { readonly [E in SupportedCiEvent]: T };

/** The `merge_group` trigger both required workflows declare. */
export const MERGE_GROUP_TRIGGER = {
  types: ['checks_requested'],
  branches: [MERGE_QUEUE_BASE_BRANCH],
} as const;

/**
 * Rendered for an event no table covers, and for a queue field GitHub did not
 * send. It is neither a SHA nor a ref, so a checkout of it fails instead of
 * defaulting to `github.sha`.
 */
export const UNAVAILABLE_EVENT_FIELD = 'ci-event-field-unavailable';
const UNAVAILABLE = `'${UNAVAILABLE_EVENT_FIELD}'`;

const eventIs = (event: string): string => `github.event_name == '${event}'`;

/**
 * A per-event value over `events`. `toJSON` makes every branch truthy (an empty string is
 * `'""'`), so an empty value for one event can never fall through to the next
 * event's value the way a bare `a && b || c` chain does; `fromJSON` restores it.
 */
export function selectEventValue<E extends string>(
  events: readonly E[],
  values: { readonly [K in E]: string },
  otherwise = UNAVAILABLE,
): string {
  const branches = events.map((event) => `(${eventIs(event)} && toJSON(${values[event]}))`);
  return `fromJSON(${branches.join(' || ')} || toJSON(${otherwise}))`;
}

/** A per-event condition over `events`: true only for an event whose own condition holds. */
export function whenEventHolds<E extends string>(
  events: readonly E[],
  conditions: { readonly [K in E]: string },
): string {
  const branches: string[] = [];
  for (const event of events) {
    const condition = conditions[event];
    if (condition === 'false') continue;
    branches.push(condition === 'true' ? eventIs(event) : `(${eventIs(event)} && ${condition})`);
  }
  return branches.length === 0 ? 'false' : `(${branches.join(' || ')})`;
}

function selectByEvent(values: PerCiEvent<string>, otherwise = UNAVAILABLE): string {
  return selectEventValue(SUPPORTED_CI_EVENTS, values, otherwise);
}

function whenEvent(conditions: PerCiEvent<string>): string {
  return whenEventHolds(SUPPORTED_CI_EVENTS, conditions);
}

const PULL_REQUEST = 'github.event.pull_request';
const MERGE_GROUP = 'github.event.merge_group';
const SAME_REPOSITORY_PULL_REQUEST = `${PULL_REQUEST}.head.repo.full_name == github.repository`;
const TARGET_BRANCH_PULL_REQUEST =
  `(${PULL_REQUEST}.base.ref == 'develop' || ${PULL_REQUEST}.base.ref == 'main')`;
const DEVELOP_QUEUE = `${MERGE_GROUP}.base_ref == '${MERGE_QUEUE_BASE_REF}'`;

/** Expression sources, per event, for every tuple field a required workflow reads. */
const fields = {
  /** The revision under test: the PR head, the queue candidate, or the dispatched commit. */
  headSha: {
    pull_request: `${PULL_REQUEST}.head.sha`,
    merge_group: `${MERGE_GROUP}.head_sha || ${UNAVAILABLE}`,
    workflow_dispatch: 'github.sha',
  },
  /** Reviewed base code runs from here; on `merge_group` it is the queue base, never the candidate. */
  trustedBaseSha: {
    pull_request: `${PULL_REQUEST}.base.sha`,
    merge_group: `${MERGE_GROUP}.base_sha || ${UNAVAILABLE}`,
    workflow_dispatch: 'github.sha',
  },
  /** The branch the change lands on, as a short name. */
  baseBranch: {
    pull_request: `${PULL_REQUEST}.base.ref`,
    merge_group: `${DEVELOP_QUEUE} && '${MERGE_QUEUE_BASE_BRANCH}' || ${UNAVAILABLE}`,
    workflow_dispatch: "''",
  },
  headBranch: {
    pull_request: `${PULL_REQUEST}.head.ref`,
    merge_group: `${MERGE_GROUP}.head_ref`,
    workflow_dispatch: "''",
  },
  /** A queue candidate lives in this repository; its PR's origin is proved at runtime. */
  headRepository: {
    pull_request: `${PULL_REQUEST}.head.repo.full_name`,
    merge_group: 'github.repository',
    workflow_dispatch: "''",
  },
  /** The queue ref is parsed and re-verified at runtime; expressions carry no PR number for it. */
  prNumber: {
    pull_request: `${PULL_REQUEST}.number`,
    merge_group: "''",
    workflow_dispatch: "''",
  },
  /** The live ref a queue candidate is fetched and re-verified from. */
  mergeGroupRef: {
    pull_request: "''",
    merge_group: `${MERGE_GROUP}.head_ref`,
    workflow_dispatch: "''",
  },
} as const satisfies Readonly<Record<string, PerCiEvent<string>>>;

/** Conditions, per event. */
const conditions = {
  /** The change is ready to be judged: a draft PR is not; a queue candidate and a dispatch are. */
  ready: {
    pull_request: `${PULL_REQUEST}.draft == false`,
    merge_group: 'true',
    workflow_dispatch: 'true',
  },
  /** The code under test belongs to this repository (a queue candidate's PR is re-proved at runtime). */
  sameRepositoryCode: {
    pull_request: SAME_REPOSITORY_PULL_REQUEST,
    merge_group: 'true',
    workflow_dispatch: 'true',
  },
  /** Same-repository code on its way into develop or main. */
  reviewedChangeIntoTarget: {
    pull_request: `${SAME_REPOSITORY_PULL_REQUEST} && ${TARGET_BRANCH_PULL_REQUEST}`,
    merge_group: DEVELOP_QUEUE,
    workflow_dispatch: 'false',
  },
  /** A reviewed change on its way into a protected branch: a pull request or a queue candidate. */
  reviewedChange: {
    pull_request: 'true',
    merge_group: 'true',
    workflow_dispatch: 'false',
  },
  /** A merge queue candidate; programs that plan it run from its trusted base checkout. */
  mergeGroup: {
    pull_request: 'false',
    merge_group: 'true',
    workflow_dispatch: 'false',
  },
  /** The event is a pull request; PR-only controllers and observations key on this. */
  pullRequest: {
    pull_request: 'true',
    merge_group: 'false',
    workflow_dispatch: 'false',
  },
  /** Reviewed code on its way in: a same-repository pull request or a queue candidate. */
  sameRepositoryReviewedChange: {
    pull_request: SAME_REPOSITORY_PULL_REQUEST,
    merge_group: 'true',
    workflow_dispatch: 'false',
  },
  /** A same-repository pull request itself; PR-only metadata work keys on this. */
  sameRepositoryPullRequest: {
    pull_request: SAME_REPOSITORY_PULL_REQUEST,
    merge_group: 'false',
    workflow_dispatch: 'false',
  },
  /** A pull request whose base is main: a production promotion candidate. */
  pullRequestIntoMain: {
    pull_request: `${PULL_REQUEST}.base.ref == 'main'`,
    merge_group: 'false',
    workflow_dispatch: 'false',
  },
  /** A pull request whose base is develop, or a develop queue candidate. */
  changeIntoDevelop: {
    pull_request: `${PULL_REQUEST}.base.ref == 'develop'`,
    merge_group: DEVELOP_QUEUE,
    workflow_dispatch: 'false',
  },
} as const satisfies Readonly<Record<string, PerCiEvent<string>>>;

export type CiEventField = keyof typeof fields;
export type CiEventCondition = keyof typeof conditions;

/** The raw expression source of one tuple field, for composing a larger expression. */
export function ciEventFieldSource(field: CiEventField): string {
  return selectByEvent(fields[field]);
}

/** One tuple field as a `${{ }}` value. */
export function ciEventField(field: CiEventField): ExpressionValue {
  return expr(ciEventFieldSource(field));
}

/** The raw expression source of one condition, for composing a job or step `if`. */
export function ciEventCondition(condition: CiEventCondition): string {
  return whenEvent(conditions[condition]);
}

/** A field with one event's entry replaced, for the few call sites whose dispatch value differs. */
export function ciEventFieldWith(
  field: CiEventField,
  overrides: Partial<PerCiEvent<string>>,
): ExpressionValue {
  return expr(selectByEvent({ ...fields[field], ...overrides }));
}

/**
 * Where a planning program runs from: `trustedRoot` (a checkout of the queue
 * base) for a merge queue candidate, so candidate code never shapes its own
 * lane selection, and the workspace (`.`) for every other event, as before.
 */
export function mergeGroupProgramRoot(trustedRoot: `.ci/${string}`): ExpressionValue {
  return expr(selectByEvent({
    pull_request: "'.'",
    merge_group: `'${trustedRoot}'`,
    workflow_dispatch: "'.'",
  }));
}

/**
 * Fields that only exist on a `pull_request` event, for steps whose own `if`
 * already admits nothing else (the base-update classifier, the retained
 * predecessor release). Named here so a raw read never appears in a workflow.
 */
export const pullRequestOnly = {
  baseSha: expr(`${PULL_REQUEST}.base.sha`),
  isSynchronize: `${eventIs('pull_request')} && github.event.action == 'synchronize'`,
} as const;

/** One concurrency key per PR, per queue candidate, and per run otherwise. */
export const ciEventConcurrencyKey = expr(selectByEvent({
  pull_request: `format('pr-{0}', ${PULL_REQUEST}.number)`,
  merge_group: `format('mq-{0}', ${MERGE_GROUP}.head_ref)`,
  workflow_dispatch: "format('event-{0}', github.run_id)",
}, "format('event-{0}', github.run_id)"));
