import { z } from 'zod';
import { marketingVersionProjectPath, readMarketingVersion, versionFromCommitMessage } from '../promotion/marketingVersion.ts';
import { hasTrustedVersionAttestation, promotionCheckpointUser } from '../promotion/versionAttestation.ts';

export { promotionCheckpointUser } from '../promotion/versionAttestation.ts';

/**
 * Every decision the iOS change gate's precheck makes, as pure functions.
 *
 * The precheck is the first thing that runs on an iOS event and it answers one
 * question: may this run reuse the evidence the event claims to carry, and
 * which lanes does it select? Two of its answers are security decisions rather
 * than routing ones — a `main` pull request must be a frozen promotion
 * checkpoint created by the checkpoint app, and a PR-backed dispatch must name
 * the exact current head of an open same-repository pull request — so each
 * check here rejects by default and returns a reason the caller annotates.
 *
 * Nothing in this module reads a file, spawns a process or makes a request.
 * The one walk that needs remote data, `verifyPromotionUpdateChain`, takes the
 * readers it uses as arguments, so its whole decision tree is exercised in
 * `ci/tests/iosGatePrecheck.test.ts` against in-memory fixtures.
 */

const shaPattern = /^[0-9a-f]{40}$/;
const promotionBranchPattern = /^promotion\/develop-([0-9a-f]{40})$/;
const positiveIntegerPattern = /^[1-9][0-9]*$/;

/**
 * How far back a promotion head may sit behind its checkpoint. Each step is
 * one GitHub-created "Update Branch" merge; 32 is far more than a promotion
 * ever accumulates and bounds the API cost of a crafted chain.
 */
export const promotionUpdateChainLimit = 32;

export function isSha40(value: unknown): value is string {
  return typeof value === 'string' && shaPattern.test(value);
}

/** `pull_request_number` must name a pull request, not an expression or a range. */
export function isPositiveInteger(value: string): boolean {
  return positiveIntegerPattern.test(value);
}

/**
 * The outputs one precheck decision writes. `shouldRun` is a string, not a
 * boolean: the gate distinguishes "decided false", "decided true" and "not
 * decided here" (empty), and the job's `outputs:` block falls through to the
 * later detector for the empty case.
 */
export interface GateOutcome {
  readonly shouldRun: '' | 'true' | 'false';
  readonly summary: string;
  readonly needsCheckout: boolean;
  readonly storekitRequired: boolean;
  readonly onboardingRequired: boolean;
  readonly budgetRequired: boolean;
  readonly productionPromotion: boolean;
  readonly evidenceRequired: boolean;
  readonly chatPlaidRequired: boolean;
  readonly incomeRequired: boolean;
}

function outcome(shouldRun: '' | 'true' | 'false', summary: string, overrides: Partial<GateOutcome> = {}): GateOutcome {
  return {
    shouldRun,
    summary,
    needsCheckout: false,
    storekitRequired: false,
    onboardingRequired: false,
    budgetRequired: false,
    productionPromotion: false,
    evidenceRequired: false,
    chatPlaidRequired: false,
    incomeRequired: false,
    ...overrides,
  };
}

/** A decision that stops the step: either it writes outputs, or it fails the run. */
export type GateDecision =
  | { readonly kind: 'outcome'; readonly outcome: GateOutcome }
  | { readonly kind: 'error'; readonly message: string };

/** A decision that may also let the step carry on to the next stage. */
export type GateStage = GateDecision | { readonly kind: 'continue' };

/**
 * The manual verification scopes. A dispatch names one and it selects exactly
 * the lanes that scope needs; the routing is a table rather than a chain of
 * shell `if`s so a scope cannot silently inherit a neighbour's lanes.
 */
export const manualScopeRouting = {
  'promotion-evidence': {
    requiresPullRequest: false, needsCheckout: true, onboardingRequired: true,
  },
  'shared-cta-evidence': { requiresPullRequest: true, evidenceRequired: true },
  'financial-independence-evidence': { requiresPullRequest: true, evidenceRequired: true },
  e2e: {
    requiresPullRequest: false,
    onboardingRequired: true,
    budgetRequired: true,
    chatPlaidRequired: true,
    incomeRequired: true,
  },
  evidence: { requiresPullRequest: false, evidenceRequired: true },
  'onboarding-copy-evidence': { requiresPullRequest: false, evidenceRequired: true },
  'mortgage-assignment-evidence': { requiresPullRequest: false },
  'debt-card-evidence': { requiresPullRequest: false, budgetRequired: true },
} as const satisfies Record<string, { readonly requiresPullRequest: boolean } & Partial<GateOutcome>>;

export type ManualScope = keyof typeof manualScopeRouting;

/** A checkpoint dispatch may read only current, immutable release endpoints. */
export function verifiedPromotionDispatchEndpoints(input: {
  readonly ref: string;
  readonly sourceSha: string;
  readonly baseSha: string;
  readonly prNumber: string;
  readonly liveDevelopSha: string | undefined;
  readonly liveMainSha: string | undefined;
}): boolean {
  return input.ref === 'refs/heads/develop' && input.prNumber === ''
    && isSha40(input.sourceSha) && isSha40(input.baseSha)
    && input.liveDevelopSha === input.sourceSha
    && input.liveMainSha === input.baseSha;
}

const manualScopeSummaries = {
  'promotion-evidence': () => 'Exact develop source and main base selected for promotion evidence.',
  'shared-cta-evidence': (pr: string) =>
    `Manual exact-head shared CTA accessibility evidence requested for PR #${pr}.`,
  'financial-independence-evidence': (pr: string) =>
    `Manual issue #3932 exact-head rendered evidence requested for PR #${pr}.`,
  e2e: () => 'Manual real-server iOS E2E run requested.',
  evidence: () => 'Manual account-update acceptance run requested.',
  'onboarding-copy-evidence': () =>
    'Manual issue #4549 onboarding-copy accessibility evidence run requested.',
  'mortgage-assignment-evidence': () =>
    'Manual issue #4001 run requested mortgage-assignment evidence only.',
  'debt-card-evidence': () =>
    'Manual issues #3998 and #3999 run requested backend and Release archive evidence only.',
} as const satisfies Record<ManualScope, (prNumber: string) => string>;

function isManualScope(scope: string): scope is ManualScope {
  return Object.hasOwn(manualScopeRouting, scope);
}

/**
 * The development E2E schema check verifies a revision, not the app, so it
 * runs before anything else is resolved and selects no iOS lane at all.
 */
export function developmentSchemaScopeDecision(testScope: string): GateDecision | null {
  if (testScope !== 'development-e2e-schema') return null;
  return {
    kind: 'outcome',
    outcome: outcome('false', 'Manual development E2E schema verification requested.'),
  };
}

/** The lanes a manual dispatch selects, or the annotation that rejects it. */
export function manualDispatchDecision(testScope: string, prNumber: string): GateDecision {
  if (!isManualScope(testScope)) {
    return {
      kind: 'outcome',
      outcome: outcome('true', 'Manual run requested iOS checks.', {
        storekitRequired: true,
        onboardingRequired: true,
        budgetRequired: true,
        evidenceRequired: true,
        chatPlaidRequired: true,
      }),
    };
  }
  const { requiresPullRequest, ...lanes } = manualScopeRouting[testScope];
  if (requiresPullRequest && !isPositiveInteger(prNumber)) {
    return { kind: 'error', message: `${testScope} requires pull_request_number.` };
  }
  return {
    kind: 'outcome',
    outcome: outcome('true', manualScopeSummaries[testScope](prNumber), lanes),
  };
}

/** The gate's own routing decision on an ordinary pull request event. */
export function changedFileRoutingOutcome(): GateOutcome {
  return outcome('', 'Checking changed files for affected iOS coverage.', { needsCheckout: true });
}

/** The gate's routing decision once a promotion checkpoint has been proved. */
export function productionPromotionOutcome(): GateOutcome {
  return outcome('true', 'Checking production promotion changes and required onboarding E2E.', {
    needsCheckout: true,
    onboardingRequired: true,
    productionPromotion: true,
  });
}

/** Select typed verifier code only after the promotion admission proof passed. */
export function trustedVerifierRevision(
  gate: GateOutcome,
  headBranch: string,
  baseSha: string,
  eventSha: string,
  testScope = '',
): string {
  if (testScope === 'promotion-evidence') {
    // The dispatch admission has already proved that this event SHA is the
    // live develop source against the exact main base. Its status programs
    // must come from that source, including on the first rollout when main
    // does not yet understand this scope.
    if (gate.productionPromotion || !gate.needsCheckout || !gate.onboardingRequired
      || !/^[0-9a-f]{40}$/.test(eventSha)) {
      throw new Error('Promotion evidence has no admitted exact develop verifier.');
    }
    return eventSha;
  }
  if (!gate.productionPromotion) return baseSha || eventSha;
  const checkpointSha = promotionCheckpointSha(headBranch);
  if (checkpointSha === null) {
    throw new Error('Admitted promotion has no valid develop checkpoint SHA.');
  }
  return checkpointSha;
}

export function draftPromotionOutcome(): GateOutcome {
  return outcome('false', 'Draft production checkpoint is idle until it is ready for review.');
}

const pullRequestSchema = z.object({
  state: z.string().optional(),
  draft: z.boolean().optional(),
  base: z.object({ ref: z.string().optional(), sha: z.string().optional() }).optional(),
  head: z.object({
    ref: z.string().optional(),
    sha: z.string().optional(),
    repo: z.object({ full_name: z.string().optional() }).nullish(),
  }).optional(),
  user: z.object({
    login: z.string().optional(),
    id: z.number().optional(),
    type: z.string().optional(),
  }).nullish(),
}).loose();

/** The event identity a dispatch adopts once its pull request has been verified. */
export interface DispatchPullRequest {
  readonly headSha: string;
  readonly headRepository: string;
  readonly baseSha: string;
  readonly baseBranch: string;
}

/**
 * A PR-backed dispatch may only adopt the identity of an open, non-draft,
 * same-repository pull request whose head is the exact commit the dispatch is
 * running at. Anything else would let a dispatch borrow another revision's
 * evidence, so this returns null and the caller refuses the run.
 */
export function verifiedDispatchPullRequest(
  body: unknown,
  repository: string,
  eventSha: string,
): DispatchPullRequest | null {
  const parsed = pullRequestSchema.safeParse(body);
  if (!parsed.success) return null;
  const pull = parsed.data;
  const headRepository = pull.head?.repo?.full_name;
  const headSha = pull.head?.sha;
  const baseRef = pull.base?.ref;
  const baseSha = pull.base?.sha;
  if (typeof headRepository !== 'string' || typeof headSha !== 'string') return null;
  if (!isSha40(baseSha)) return null;
  if (pull.state !== 'open' || pull.draft !== false) return null;
  if (headRepository !== repository || headSha !== eventSha) return null;
  if (baseRef !== 'develop' && baseRef !== 'main') return null;
  return { headSha, headRepository, baseSha, baseBranch: baseRef };
}

export interface PullRequestEventIdentity {
  readonly baseBranch: string;
  readonly baseSha: string;
  readonly headBranch: string;
  readonly headSha: string;
  readonly headRepository: string;
}

/**
 * The live pull request must still be the one this event describes. A head or
 * base that moved after the event means a newer event owns the checks, and
 * continuing would attach this run's verdict to a revision nobody reviewed.
 */
export function pullRequestStillMatchesEvent(body: unknown, event: PullRequestEventIdentity): boolean {
  const parsed = pullRequestSchema.safeParse(body);
  if (!parsed.success) return false;
  const pull = parsed.data;
  return pull.state === 'open'
    && pull.base?.ref === event.baseBranch
    && pull.base?.sha === event.baseSha
    && pull.head?.ref === event.headBranch
    && pull.head?.sha === event.headSha
    && pull.head?.repo?.full_name === event.headRepository;
}

export function isCheckpointAppPullRequest(body: unknown): boolean {
  const parsed = pullRequestSchema.safeParse(body);
  if (!parsed.success) return false;
  const user = parsed.data.user;
  return user?.login === promotionCheckpointUser.login
    && user.id === promotionCheckpointUser.id
    && user.type === promotionCheckpointUser.type;
}

export function isDraftPullRequest(body: unknown): boolean {
  const parsed = pullRequestSchema.safeParse(body);
  return parsed.success && parsed.data.draft === true;
}

/**
 * What a `main` pull request must already be before its checkpoint is even
 * looked at: opened from this repository, opened by the checkpoint app, and
 * ready for review. A draft idles rather than running or failing, because a
 * promotion is prepared in the open and only becomes a claim on main when it
 * leaves draft.
 */
export function promotionAdmission(
  body: unknown,
  headRepository: string,
  repository: string,
): GateStage {
  if (headRepository !== repository) {
    return { kind: 'error', message: 'main only accepts production promotion checkpoints from this repository' };
  }
  if (!isCheckpointAppPullRequest(body)) {
    return {
      kind: 'error',
      message: 'main only accepts production promotion pull requests created by the checkpoint app',
    };
  }
  if (isDraftPullRequest(body)) return { kind: 'outcome', outcome: draftPromotionOutcome() };
  return { kind: 'continue' };
}

/**
 * Only an exact `promotion/develop-<sha>` head names a frozen checkpoint.
 * Trusting head ancestry instead would accept any same-repository ancestor of
 * develop, including one that never went through a checkpoint.
 */
export function promotionCheckpointSha(headBranch: string): string | null {
  return promotionBranchPattern.exec(headBranch)?.[1] ?? null;
}

const comparisonSchema = z.object({
  status: z.string().optional(),
  merge_base_commit: z.object({ sha: z.string().optional() }).optional(),
}).loose();

/** The checkpoint must be develop itself or an ancestor of it. */
export function checkpointIsOnDevelop(body: unknown, checkpointSha: string): boolean {
  const parsed = comparisonSchema.safeParse(body);
  if (!parsed.success) return false;
  const { status, merge_base_commit: mergeBase } = parsed.data;
  return (status === 'ahead' || status === 'identical') && mergeBase?.sha === checkpointSha;
}

/**
 * Each older update in a chain must target a strictly earlier main than the
 * update after it. "behind", "identical" and "diverged" all mean the chain
 * repeats, reorders or forks main rather than advancing along it.
 */
export function mainAncestryAdvances(body: unknown, updateBase: string): boolean {
  const parsed = comparisonSchema.safeParse(body);
  if (!parsed.success) return false;
  return parsed.data.status === 'ahead' && parsed.data.merge_base_commit?.sha === updateBase;
}

export function mergeBaseSha(body: unknown): string | null {
  const parsed = comparisonSchema.safeParse(body);
  if (!parsed.success) return null;
  const sha = parsed.data.merge_base_commit?.sha;
  return isSha40(sha) ? sha : null;
}

const commitSchema = z.object({
  sha: z.string().optional(),
  parents: z.array(z.object({ sha: z.string().optional() }).loose()).optional(),
  commit: z.object({
    message: z.string().optional(),
    committer: z.object({ name: z.string().optional(), email: z.string().optional() }).optional(),
    verification: z.object({
      verified: z.boolean().optional(),
      reason: z.string().optional(),
      signature: z.unknown().optional(),
    }).optional(),
    tree: z.object({ sha: z.string().optional() }).optional(),
  }).optional(),
  committer: z.object({ login: z.string().optional(), id: z.number().optional() }).nullish(),
}).loose();

export interface CanonicalUpdateCommit {
  readonly firstParent: string;
  readonly updateBase: string;
  readonly tree: string;
}

/**
 * A promotion head may only be a GitHub-created Update Branch merge. Parent
 * shape alone is not enough: a locally crafted merge can name the expected two
 * parents and carry any tree at all, so the signature, the canonical message,
 * the web-flow committer identity and the tree SHA are all checked, and the
 * tree is reproduced from the parents by the caller.
 */
export function canonicalPromotionUpdateCommit(
  body: unknown,
  expected: { readonly sha: string; readonly message: string },
): CanonicalUpdateCommit | null {
  const parsed = commitSchema.safeParse(body);
  if (!parsed.success) return null;
  const commit = parsed.data;
  if (commit.sha !== expected.sha) return null;
  const parents = commit.parents ?? [];
  if (parents.length !== 2) return null;
  const firstParent = parents[0]?.sha;
  const updateBase = parents[1]?.sha;
  if (!isSha40(firstParent) || !isSha40(updateBase)) return null;
  const detail = commit.commit;
  if (detail?.message !== expected.message) return null;
  if (detail.committer?.name !== 'GitHub' || detail.committer.email !== 'noreply@github.com') return null;
  const verification = detail.verification;
  if (verification?.verified !== true || verification.reason !== 'valid') return null;
  if (typeof verification.signature !== 'string' || verification.signature.length === 0) return null;
  if (commit.committer?.login !== 'web-flow' || commit.committer.id !== 19864447) return null;
  const tree = detail.tree?.sha;
  if (!isSha40(tree)) return null;
  return { firstParent, updateBase, tree };
}

/** One GitHub metadata read, as the precheck sees it. */
export type GateApiOutcome =
  | { readonly kind: 'response'; readonly statusLabel: string; readonly body: unknown }
  | { readonly kind: 'unreachable' };

/** Checkpoint version evidence is pinned to the App actor and immutable source commit. */
export async function checkpointHasVersionAttestation(
  read: (url: string) => Promise<GateApiOutcome>,
  apiRoot: string,
  prNumber: string,
  source: string,
  commit: string,
  version: string,
): Promise<boolean> {
  for (let page = 1; page <= 20; page += 1) {
    const result = await read(`${apiRoot}/issues/${prNumber}/comments?per_page=100&page=${page}`);
    if (result.kind !== 'response' || result.statusLabel !== '200' || !Array.isArray(result.body)) return false;
    if (hasTrustedVersionAttestation(result.body, { sourceSha: source, commitSha: commit, version })) return true;
    if (result.body.length < 100) return false;
  }
  return false;
}

/** A bare checkpoint also needs the App's version selection, even without a version commit. */
export async function verifyBareCheckpointVersion(
  read: (url: string) => Promise<GateApiOutcome>,
  apiRoot: string,
  prNumber: string,
  sourceSha: string,
): Promise<boolean> {
  const file = await read(`${apiRoot}/contents/${marketingVersionProjectPath}?ref=${sourceSha}`);
  const content = z.object({ encoding: z.literal('base64'), content: z.string() }).safeParse(
    file.kind === 'response' && file.statusLabel === '200' ? file.body : null,
  );
  if (!content.success) return false;
  let version: string;
  try { version = readMarketingVersion(Buffer.from(content.data.content, 'base64').toString('utf8')); }
  catch { return false; }
  return checkpointHasVersionAttestation(read, apiRoot, prNumber, sourceSha, sourceSha, version);
}

export interface PromotionChainReaders {
  readonly readCommit: (sha: string) => Promise<GateApiOutcome>;
  readonly compare: (from: string, to: string) => Promise<GateApiOutcome>;
  /** Makes `sha` available to the local merge proof; false when no credential could fetch it. */
  readonly fetchObject: (sha: string) => Promise<boolean>;
  /** The tree git itself computes for a merge, or null when it does not merge cleanly. */
  readonly mergeTree: (mergeBase: string, left: string, right: string) => Promise<string | null>;
  /** Proves the only changed file is the expected deterministic project version rewrite. */
  readonly verifyVersionChange: (source: string, commit: string, version: string) => Promise<boolean>;
  /** Proves the trusted checkpoint App attested the exact selected version and commit. */
  readonly verifyVersionAttestation: (source: string, commit: string, version: string) => Promise<boolean>;
  /** Proves the App selected the unmodified source as the versioned checkpoint. */
  readonly verifyBareCheckpointVersion: (source: string) => Promise<boolean>;
}

export interface PromotionChainInput {
  readonly headSha: string;
  readonly headBranch: string;
  readonly baseSha: string;
  readonly checkpointSha: string;
}

export type PromotionChainResult =
  | { readonly kind: 'verified' }
  | { readonly kind: 'error'; readonly message: string };

function chainError(message: string): PromotionChainResult {
  return { kind: 'error', message };
}

/**
 * Walks the first-parent chain from the promotion head back to the frozen
 * checkpoint, proving at every step that the commit is a GitHub Update Branch
 * merge whose tree is exactly the one git computes for its parents and whose
 * main parent advances in order. The head itself may be the checkpoint, in
 * which case the caller never reaches here.
 */
export async function verifyPromotionUpdateChain(
  input: PromotionChainInput,
  readers: PromotionChainReaders,
): Promise<PromotionChainResult> {
  const expectedMessage = `Merge branch 'main' into ${input.headBranch}`;
  let currentSha = input.headSha;
  let expectedBase = input.baseSha;

  for (let depth = 1; depth <= promotionUpdateChainLimit; depth += 1) {
    const commitRead = await readers.readCommit(currentSha);
    if (commitRead.kind === 'unreachable') {
      return chainError(`Could not verify promotion update commit ${currentSha}.`);
    }
    if (commitRead.statusLabel !== '200') {
      return chainError(
        `Unexpected GitHub response while checking promotion update commit ${currentSha}: HTTP ${commitRead.statusLabel}.`,
      );
    }
    const canonical = canonicalPromotionUpdateCommit(commitRead.body, {
      sha: currentSha,
      message: expectedMessage,
    });
    if (canonical === null) {
      const parsed = commitSchema.safeParse(commitRead.body);
      const commit = parsed.success ? parsed.data : null;
      const version = commit?.commit?.message === undefined
        ? null : versionFromCommitMessage(commit.commit.message);
      if (version === null || commit?.sha !== currentSha
        || commit.parents?.length !== 1 || commit.parents[0]?.sha !== input.checkpointSha) {
        return chainError(`Promotion update commit ${currentSha} lacks canonical GitHub provenance or a verified version-only change.`);
      }
      if (!await readers.verifyVersionChange(input.checkpointSha, currentSha, version)) {
        return chainError(`Promotion version commit ${currentSha} changes more than the iOS marketing version.`);
      }
      if (!await readers.verifyVersionAttestation(input.checkpointSha, currentSha, version)) {
        return chainError(`Promotion version commit ${currentSha} lacks a trusted checkpoint App attestation.`);
      }
      if (depth === 1) {
        const ancestry = await readers.compare(input.baseSha, currentSha);
        if (ancestry.kind !== 'response' || ancestry.statusLabel !== '200'
          || !checkpointIsOnDevelop(ancestry.body, input.baseSha)) {
          return chainError(`Promotion version commit ${currentSha} does not contain current main ${input.baseSha}.`);
        }
      }
      return { kind: 'verified' };
    }
    const { firstParent, updateBase, tree } = canonical;

    if (depth === 1) {
      if (updateBase !== input.baseSha) {
        return chainError(`Newest promotion update commit does not target current main ${input.baseSha}.`);
      }
    } else {
      const lineage = await readers.compare(updateBase, expectedBase);
      if (lineage.kind === 'unreachable') {
        return chainError(`Could not verify ordered main ancestry for promotion update ${currentSha}.`);
      }
      if (lineage.statusLabel !== '200' || !mainAncestryAdvances(lineage.body, updateBase)) {
        return chainError('Promotion update chain contains stale, repeated, or reordered main ancestry.');
      }
    }

    const mergeLineage = await readers.compare(firstParent, updateBase);
    if (mergeLineage.kind === 'unreachable') {
      return chainError(`Could not determine merge base for promotion update ${currentSha}.`);
    }
    if (mergeLineage.statusLabel !== '200') {
      return chainError(
        `Unexpected GitHub response while finding promotion merge base: HTTP ${mergeLineage.statusLabel}.`,
      );
    }
    const base = mergeBaseSha(mergeLineage.body);
    if (base === null) {
      return chainError(`Could not read a merge base commit for promotion update ${currentSha}.`);
    }

    for (const object of [firstParent, updateBase, base]) {
      if (!await readers.fetchObject(object)) {
        return chainError(`Could not fetch exact promotion merge object ${object}.`);
      }
    }
    const reproduced = await readers.mergeTree(base, firstParent, updateBase);
    if (reproduced === null) {
      return chainError(`Promotion update ${currentSha} does not reproduce as a clean git merge.`);
    }
    if (!isSha40(reproduced) || reproduced !== tree) {
      return chainError(
        `Promotion update ${currentSha} tree does not match the canonical merge of its parents.`,
      );
    }

    if (firstParent === input.checkpointSha) {
      if (!await readers.verifyBareCheckpointVersion(input.checkpointSha)) {
        return chainError(`Promotion checkpoint ${input.checkpointSha} lacks a trusted checkpoint App source-version attestation.`);
      }
      return { kind: 'verified' };
    }
    currentSha = firstParent;
    expectedBase = updateBase;
  }
  return chainError(
    `Promotion update chain did not reach checkpoint ${input.checkpointSha} within ${promotionUpdateChainLimit} verified updates.`,
  );
}
