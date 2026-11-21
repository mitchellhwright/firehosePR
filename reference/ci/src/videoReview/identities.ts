export interface VideoFindingIdentity {
  readonly description: string;
  readonly canonicalIssue: number;
  readonly legacyIssues: readonly number[];
}

// Controlled IDs describe the defect, never the model's title or reviewer name.
// Grow this catalog only after reconciling existing canonical/closed issues.
export const VIDEO_FINDING_IDENTITIES = Object.freeze({
  'accessibility.paywall.renewal-disclosure': Object.freeze({
    description: 'Paywall renewal disclosure and legal links have insufficient readability, contrast or Dynamic Type support.',
    canonicalIssue: 4502,
    legacyIssues: Object.freeze([4530, 4716, 4674]),
  }),
  'copy.budget.manual-account-readiness': Object.freeze({
    description: 'About Budget claims readiness without an eligible transaction-backed account.',
    canonicalIssue: 4510,
    legacyIssues: Object.freeze([4506]),
  }),
}) satisfies Readonly<Record<string, VideoFindingIdentity>>;

export type VideoFindingId = keyof typeof VIDEO_FINDING_IDENTITIES;

export interface CanonicalIssueCandidate {
  readonly number?: number;
  readonly pull_request?: unknown;
  readonly state?: string;
  readonly body?: unknown;
}

export type CanonicalFindingTarget =
  | { readonly action: 'triage'; readonly reason: string }
  | { readonly action: 'append'; readonly issueNumber: number };

function isVideoFindingId(id: unknown): id is VideoFindingId {
  return typeof id === 'string' && Object.hasOwn(VIDEO_FINDING_IDENTITIES, id);
}

export function videoFindingIdentity(id: unknown): VideoFindingIdentity | null {
  return isVideoFindingId(id) ? VIDEO_FINDING_IDENTITIES[id] : null;
}

export function videoFindingMarker(id: unknown): string {
  if (videoFindingIdentity(id) === null) throw new Error('Unknown video finding identity');
  return `<!-- example-video-finding id=${id} -->`;
}

export function canonicalFindingTarget(
  id: unknown,
  issue: CanonicalIssueCandidate | null | undefined,
): CanonicalFindingTarget {
  const identity = videoFindingIdentity(id);
  if (identity === null) return { action: 'triage', reason: 'unknown identity' };
  if (issue?.number !== identity.canonicalIssue || issue.pull_request) {
    return { action: 'triage', reason: 'canonical issue mismatch' };
  }
  if (issue.state !== 'open') return { action: 'triage', reason: 'closed canonical recurrence' };
  if (typeof issue.body !== 'string' || !issue.body.split(/\r?\n/).includes(videoFindingMarker(id))) {
    return { action: 'triage', reason: 'canonical migration missing' };
  }
  return { action: 'append', issueNumber: identity.canonicalIssue };
}
