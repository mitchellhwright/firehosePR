import { normalizeReview } from '../actions/reviewOnboardingVideo.ts';
import type { VideoComment } from './github.ts';
import {
  canonicalFindingTarget,
  videoFindingIdentity,
} from './identities.ts';

const BEGIN = '<!-- example-video-occurrence-ledger -->';
const END = '<!-- /example-video-occurrence-ledger -->';
const DAY = 24 * 60 * 60 * 1000;

interface VideoFinding {
  readonly id: string;
  readonly kind: string;
  readonly severity: string;
  readonly evidence: string;
  readonly frame_indices: readonly number[];
  readonly log_excerpt: string;
  readonly recommendation: string;
}

interface VideoIssue {
  readonly number?: number;
  readonly state?: string;
  readonly body?: unknown;
  readonly pull_request?: unknown;
}

interface OccurrenceComment {
  readonly id?: number;
  readonly body?: unknown;
  readonly user?: { readonly login?: string };
  readonly createdAt?: string;
}

interface VideoOccurrenceLedger {
  readonly version: 1;
  readonly id: string;
  readonly runIds: string[];
  lastNotifiedAt: string | null;
}

export interface VideoOccurrenceApi {
  readonly writerLogin: string;
  readonly getIssue: (number: number) => Promise<unknown>;
  readonly listComments: (number: number) => Promise<readonly unknown[]>;
  readonly updateLedgerComment: (
    number: number,
    expected: VideoComment,
    body: string,
  ) => Promise<unknown>;
  readonly postComment: (number: number, body: string) => Promise<unknown>;
}

interface AppendPlan {
  readonly action: 'append';
  readonly duplicate: boolean;
  readonly ledger: VideoOccurrenceLedger;
  readonly ledgerComment: OccurrenceComment | undefined;
  readonly body: string;
  readonly issueNumber: number;
}

type VideoOccurrencePlan =
  | AppendPlan
  | { readonly action: 'triage'; readonly reason: string };

function record(value: unknown): Readonly<Record<string, unknown>> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Readonly<Record<string, unknown>>
    : undefined;
}

function videoIssue(value: unknown): VideoIssue {
  const candidate = record(value);
  return {
    ...(typeof candidate?.['number'] === 'number' ? { number: candidate['number'] } : {}),
    ...(typeof candidate?.['state'] === 'string' ? { state: candidate['state'] } : {}),
    ...(candidate !== undefined && 'body' in candidate ? { body: candidate['body'] } : {}),
    ...(candidate !== undefined && 'pull_request' in candidate
      ? { pull_request: candidate['pull_request'] }
      : {}),
  };
}

function videoComment(value: unknown): OccurrenceComment {
  const candidate = record(value);
  const user = record(candidate?.['user']);
  return {
    ...(typeof candidate?.['id'] === 'number' ? { id: candidate['id'] } : {}),
    ...(candidate !== undefined && 'body' in candidate ? { body: candidate['body'] } : {}),
    ...(typeof user?.['login'] === 'string' ? { user: { login: user['login'] } } : {}),
    ...(typeof candidate?.['createdAt'] === 'string' ? { createdAt: candidate['createdAt'] } : {}),
  };
}

function requiredVideoComment(value: OccurrenceComment): VideoComment {
  if (!Number.isSafeInteger(value.id) || typeof value.id !== 'number' || value.id <= 0
    || typeof value.body !== 'string' || typeof value.user?.login !== 'string'
    || value.user.login.length === 0 || typeof value.createdAt !== 'string'
    || !Number.isFinite(Date.parse(value.createdAt))) {
    throw new Error('Invalid video comment evidence');
  }
  return {
    id: value.id,
    body: value.body,
    user: { login: value.user.login },
    createdAt: value.createdAt,
  };
}

function parseFinding(value: unknown): VideoFinding | undefined {
  const candidate = record(value);
  const id = candidate?.['id'];
  const kind = candidate?.['kind'];
  const severity = candidate?.['severity'];
  const evidence = candidate?.['evidence'];
  const frameIndices = candidate?.['frame_indices'];
  const logExcerpt = candidate?.['log_excerpt'];
  const recommendation = candidate?.['recommendation'];
  if (typeof id !== 'string' || typeof kind !== 'string' || typeof severity !== 'string') return undefined;
  return {
    id,
    kind,
    severity,
    evidence: typeof evidence === 'string' ? evidence : '',
    frame_indices: Array.isArray(frameIndices)
      ? frameIndices.filter((index): index is number => typeof index === 'number')
      : [],
    log_excerpt: typeof logExcerpt === 'string' ? logExcerpt : '',
    recommendation: typeof recommendation === 'string' ? recommendation : '',
  };
}

function readLedger(body: unknown, id: string): VideoOccurrenceLedger {
  if (typeof body !== 'string') throw new Error('Invalid video occurrence ledger');
  const start = body.indexOf(BEGIN);
  if (start < 0) return { version: 1, id, runIds: [], lastNotifiedAt: null };
  const end = body.indexOf(END, start);
  if (end < 0 || body.includes(BEGIN, start + BEGIN.length)) {
    throw new Error('Invalid video occurrence ledger');
  }
  const block = body.slice(start + BEGIN.length, end).trim();
  const json = block.match(/^Distinct review runs: [0-9]+\n<!-- data: (.+) -->$/)?.[1];
  if (json === undefined) throw new Error('Invalid video occurrence ledger');
  let value: unknown;
  try {
    value = JSON.parse(json);
  } catch {
    throw new Error('Invalid video occurrence ledger');
  }
  const ledger = record(value);
  const runIds = ledger?.['runIds'];
  const lastNotifiedAt = ledger?.['lastNotifiedAt'];
  if (ledger?.['version'] !== 1 || ledger['id'] !== id || !Array.isArray(runIds)
    || runIds.some(run => typeof run !== 'string' || !/^[1-9][0-9]*$/.test(run))
    || new Set(runIds).size !== runIds.length
    || (lastNotifiedAt !== null
      && (typeof lastNotifiedAt !== 'string' || !Number.isFinite(Date.parse(lastNotifiedAt))))) {
    throw new Error('Invalid video occurrence ledger');
  }
  return {
    version: 1,
    id,
    runIds: runIds as string[],
    lastNotifiedAt: lastNotifiedAt as string | null,
  };
}

function writeLedger(ledger: VideoOccurrenceLedger): string {
  const body = `${BEGIN}\nDistinct review runs: ${ledger.runIds.length}\n<!-- data: ${JSON.stringify(ledger)} -->\n${END}\n`;
  if (body.length > 60_000) {
    throw new Error('Video occurrence ledger requires archival before further writes');
  }
  return body;
}

export function planVideoOccurrence(
  issueValue: unknown,
  findingValue: unknown,
  runId: string,
  commentValues: readonly unknown[] = [],
  writerLogin?: string,
): VideoOccurrencePlan {
  if (!/^[1-9][0-9]*$/.test(runId)) throw new Error('Invalid video run identity');
  const finding = parseFinding(findingValue);
  if (finding === undefined || finding.kind !== 'product_defect'
    || !['critical', 'important'].includes(finding.severity)) {
    return { action: 'triage', reason: 'not a material product finding' };
  }
  const issue = videoIssue(issueValue);
  const target = canonicalFindingTarget(finding.id, issue);
  if (target.action !== 'append') return target;
  if (!Array.isArray(commentValues)) throw new Error('Video comment evidence unavailable');
  const comments = commentValues.map(videoComment);
  const owned = comments.filter(comment => comment.user?.login === writerLogin
    && typeof comment.body === 'string' && comment.body.includes(BEGIN));
  if (owned.length > 1) throw new Error('Multiple video occurrence ledgers require triage');
  const ledgerComment = owned[0];
  // Read a legacy body ledger only to migrate it; never replace human issue text.
  const ledger = readLedger(ledgerComment?.body ?? issue.body, finding.id);
  const duplicate = ledger.runIds.includes(runId);
  if (!duplicate) ledger.runIds.push(runId);
  return {
    action: 'append',
    duplicate,
    ledger,
    ledgerComment,
    body: writeLedger(ledger),
    issueNumber: target.issueNumber,
  };
}

/**
 * Requires one externally serialized writer across the repository. `api` must
 * list ALL issue comments and preserve errors; never interpret a failed read as
 * an empty list. Input findings are revalidated against the saved producer
 * context. This module never runs the model or creates/closes issues.
 */
export async function recordVideoOccurrence(input: {
  readonly finding: unknown;
  readonly context: unknown;
  readonly runId: string;
  readonly api: VideoOccurrenceApi;
  readonly now?: Date;
}): Promise<Readonly<Record<string, unknown>>> {
  const { context, runId, api, now = new Date() } = input;
  const validated = normalizeReview(
    'writer',
    { verdict: 'needs_changes', findings: [input.finding] },
    record(context),
  );
  const normalizedFinding = validated.findings[0];
  if (validated.verdict === 'unknown' || normalizedFinding === undefined) {
    return { action: 'triage', reason: 'invalid product evidence' };
  }
  const finding = parseFinding(normalizedFinding);
  if (finding === undefined) return { action: 'triage', reason: 'invalid product evidence' };
  const identity = videoFindingIdentity(finding.id);
  if (identity === null) return { action: 'triage', reason: 'unknown identity' };
  if (api.writerLogin.length === 0) throw new Error('Authenticated video writer identity required');
  let issue = videoIssue(await api.getIssue(identity.canonicalIssue));
  let target = canonicalFindingTarget(finding.id, issue);
  if (target.action !== 'append') return target;
  let comments = (await api.listComments(target.issueNumber)).map(videoComment);
  let plan = planVideoOccurrence(issue, finding, runId, comments, api.writerLogin);
  if (plan.action !== 'append') return plan;
  if (plan.ledgerComment === undefined) {
    await api.postComment(plan.issueNumber, plan.body);
  } else if (plan.body !== plan.ledgerComment.body) {
    await api.updateLedgerComment(plan.issueNumber, requiredVideoComment(plan.ledgerComment), plan.body);
  }
  // An ambiguous creation/update is retried from saved evidence. Read the bot's
  // persisted ledger before notification; never PATCH the human-owned issue.
  issue = videoIssue(await api.getIssue(identity.canonicalIssue));
  target = canonicalFindingTarget(finding.id, issue);
  if (target.action !== 'append') return { action: 'triage', reason: 'canonical state changed' };
  comments = (await api.listComments(target.issueNumber)).map(videoComment);
  plan = planVideoOccurrence(issue, finding, runId, comments, api.writerLogin);
  if (plan.action !== 'append' || plan.ledgerComment === undefined
    || !readLedger(plan.ledgerComment.body, finding.id).runIds.includes(runId)) {
    throw new Error('Video occurrence persistence not confirmed');
  }
  const ledger = plan.ledger;
  const marker = `<!-- example-video-notification id=${finding.id} run=${runId} -->`;
  const prefix = `<!-- example-video-notification id=${finding.id} run=`;
  const notifications = comments.filter(comment => comment.user?.login === api.writerLogin
    && typeof comment.body === 'string' && comment.body.split(/\r?\n/).some(line => (
      line.startsWith(prefix) && line.endsWith(' -->')
      && /^[1-9][0-9]*$/.test(line.slice(prefix.length, -4))
    )));
  if (notifications.some(comment => typeof comment.createdAt !== 'string'
    || !Number.isFinite(Date.parse(comment.createdAt)))) {
    throw new Error('Video notification timestamp unavailable');
  }
  const existing = notifications.find(comment => (
    typeof comment.body === 'string' && comment.body.split(/\r?\n/).includes(marker)
  ));
  const times = notifications.map(comment => Date.parse(String(comment.createdAt)));
  if (ledger.lastNotifiedAt !== null) times.push(Date.parse(ledger.lastNotifiedAt));
  const latest = times.length > 0 ? Math.max(...times) : null;
  let notification: 'recovered' | 'posted' | 'throttled' = existing === undefined ? 'posted' : 'recovered';
  let notificationTime: number;
  if (existing !== undefined || (latest !== null && now.getTime() - latest < DAY)) {
    notification = existing === undefined ? 'throttled' : 'recovered';
    if (latest === null) throw new Error('Video notification timestamp unavailable');
    notificationTime = latest;
  } else {
    const receipt = videoComment(await api.postComment(
      target.issueNumber,
      `${marker}\nNeeds human verification. ${ledger.runIds.length} distinct review runs recorded.\n\nRun: https://github.com/example-org/example-app/actions/runs/${runId}\nSeverity: ${finding.severity}\nEvidence: ${finding.evidence}\nSampled frames: ${finding.frame_indices.join(', ') || 'None; timeline reference below'}\nTimeline excerpt: ${finding.log_excerpt || 'None; frame references above'}\nRecommendation: ${finding.recommendation}`,
    ));
    if (typeof receipt.createdAt !== 'string' || !Number.isFinite(Date.parse(receipt.createdAt))) {
      throw new Error('Video notification receipt unavailable');
    }
    notificationTime = Date.parse(receipt.createdAt);
  }
  issue = videoIssue(await api.getIssue(identity.canonicalIssue));
  target = canonicalFindingTarget(finding.id, issue);
  if (target.action !== 'append') return { action: 'triage', reason: 'canonical state changed' };
  comments = (await api.listComments(target.issueNumber)).map(videoComment);
  const current = planVideoOccurrence(issue, finding, runId, comments, api.writerLogin);
  if (current.action !== 'append' || current.ledgerComment === undefined
    || !readLedger(current.ledgerComment.body, finding.id).runIds.includes(runId)) {
    throw new Error('Video occurrence ledger changed unexpectedly');
  }
  current.ledger.lastNotifiedAt = new Date(notificationTime).toISOString();
  const body = writeLedger(current.ledger);
  if (body !== current.ledgerComment.body) {
    await api.updateLedgerComment(target.issueNumber, requiredVideoComment(current.ledgerComment), body);
  }
  return {
    action: 'recorded',
    issueNumber: target.issueNumber,
    distinctRuns: current.ledger.runIds.length,
    notification,
  };
}
