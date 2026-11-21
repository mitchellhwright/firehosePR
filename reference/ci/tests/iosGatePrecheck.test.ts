import assert from 'node:assert/strict';
import test from 'node:test';

import {
  canonicalPromotionUpdateCommit,
  changedFileRoutingOutcome,
  checkpointIsOnDevelop,
  developmentSchemaScopeDecision,
  draftPromotionOutcome,
  isCheckpointAppPullRequest,
  isDraftPullRequest,
  isPositiveInteger,
  isSha40,
  mainAncestryAdvances,
  manualDispatchDecision,
  manualScopeRouting,
  mergeBaseSha,
  productionPromotionOutcome,
  promotionAdmission,
  promotionCheckpointSha,
  promotionUpdateChainLimit,
  pullRequestStillMatchesEvent,
  trustedVerifierRevision,
  verifiedDispatchPullRequest,
  verifiedPromotionDispatchEndpoints,
  verifyPromotionUpdateChain,
  verifyBareCheckpointVersion,
  type GateApiOutcome,
  type GateOutcome,
  type PromotionChainReaders,
} from '../src/ios/iosGatePrecheck.ts';
import { promotionCheckpointUser, versionAttestationBody } from '../src/promotion/versionAttestation.ts';

const repository = 'example-org/example-app';
const checkpointSha = 'a'.repeat(40);
const baseSha = 'b'.repeat(40);
const headSha = 'c'.repeat(40);
const defaultTree = 'f'.repeat(40);
const branch = `promotion/develop-${checkpointSha}`;

test('bare promotion checkpoint needs an App-attested source version', async () => {
  const project = '\t\tMARKETING_VERSION = 1.5.2;\n'.repeat(16);
  const body = versionAttestationBody({ sourceSha: checkpointSha, commitSha: checkpointSha, version: '1.5.2' });
  const read = async (url: string): Promise<GateApiOutcome> => ({
    kind: 'response', statusLabel: '200', body: url.includes('/contents/')
      ? { encoding: 'base64', content: Buffer.from(project).toString('base64') }
      : [{ body, user: promotionCheckpointUser }],
  });
  assert.equal(await verifyBareCheckpointVersion(read, 'https://api.github.test/repos/example-org/example-app', '6094', checkpointSha), true);
  const writer = async (url: string): Promise<GateApiOutcome> => ({
    kind: 'response', statusLabel: '200', body: url.includes('/contents/')
      ? { encoding: 'base64', content: Buffer.from(project).toString('base64') }
      : [{ body, user: { ...promotionCheckpointUser, id: 1 } }],
  });
  assert.equal(await verifyBareCheckpointVersion(writer, 'https://api.github.test/repos/example-org/example-app', '6094', checkpointSha), false);
});

function selectedLanes(outcome: GateOutcome): string[] {
  return (Object.entries(outcome) as [keyof GateOutcome, GateOutcome[keyof GateOutcome]][])
    .filter(([name, value]) => value === true && name !== 'needsCheckout')
    .map(([name]) => name)
    .sort();
}

function decidedOutcome(scope: string, prNumber = ''): GateOutcome {
  const decision = manualDispatchDecision(scope, prNumber);
  assert.equal(decision.kind, 'outcome', `${scope} must decide an outcome`);
  if (decision.kind !== 'outcome') throw new Error('unreachable');
  return decision.outcome;
}

test('the development E2E schema scope short-circuits before any lane is resolved', () => {
  const decision = developmentSchemaScopeDecision('development-e2e-schema');
  assert.ok(decision !== null);
  assert.equal(decision.kind, 'outcome');
  if (decision.kind !== 'outcome') return;
  assert.equal(decision.outcome.shouldRun, 'false');
  assert.equal(decision.outcome.needsCheckout, false);
  assert.deepEqual(selectedLanes(decision.outcome), []);
  assert.match(decision.outcome.summary, /Manual development E2E schema verification requested\./);
  // Every other scope, including the empty one an ordinary event carries,
  // must fall through instead of adopting the schema verification's answer.
  for (const scope of ['', 'e2e', 'evidence', 'development-e2e-schemas']) {
    assert.equal(developmentSchemaScopeDecision(scope), null, scope);
  }
});

test('each manual scope selects exactly its own lanes', () => {
  // The lanes are asserted literally rather than read back out of the routing
  // table: the point of the test is that the table itself is right, and a
  // scope quietly inheriting a neighbour's lane is the failure it must catch.
  const expected: Record<string, string[]> = {
    'promotion-evidence': ['onboardingRequired'],
    'shared-cta-evidence': ['evidenceRequired'],
    'financial-independence-evidence': ['evidenceRequired'],
    e2e: ['budgetRequired', 'chatPlaidRequired', 'incomeRequired', 'onboardingRequired'],
    evidence: ['evidenceRequired'],
    'onboarding-copy-evidence': ['evidenceRequired'],
    'mortgage-assignment-evidence': [],
    // Named for the backend and Release archive evidence it collects, but the
    // dispatch has always also selected the budget lane.
    'debt-card-evidence': ['budgetRequired'],
  };
  assert.deepEqual(Object.keys(expected).sort(), Object.keys(manualScopeRouting).sort());
  for (const [scope, lanes] of Object.entries(expected)) {
    const outcome = decidedOutcome(scope, '4992');
    assert.equal(outcome.shouldRun, 'true', scope);
    assert.equal(outcome.needsCheckout, scope === 'promotion-evidence', scope);
    assert.equal(outcome.productionPromotion, false, scope);
    assert.deepEqual(selectedLanes(outcome), lanes, scope);
  }
});

test('promotion dispatch binds live develop and main refs to exact source/base without a PR head', () => {
  const sourceSha = 'a'.repeat(40);
  const baseSha = 'b'.repeat(40);
  const accepted = { ref: 'refs/heads/develop', sourceSha, baseSha,
    prNumber: '', liveDevelopSha: sourceSha, liveMainSha: baseSha };
  assert.equal(verifiedPromotionDispatchEndpoints(accepted), true);
  for (const invalid of [
    { liveDevelopSha: 'c'.repeat(40) },
    { liveMainSha: 'c'.repeat(40) },
    { liveMainSha: undefined },
    { prNumber: '6102' },
    { ref: 'refs/heads/main' },
    { baseSha: 'not-a-sha' },
  ]) assert.equal(verifiedPromotionDispatchEndpoints({ ...accepted, ...invalid }), false);
});

test('an unrecognised scope falls back to the broad manual run without the income lane', () => {
  for (const scope of ['', 'unknown', 'E2E', 'evidence ']) {
    const outcome = decidedOutcome(scope);
    assert.equal(outcome.shouldRun, 'true', scope);
    assert.deepEqual(
      selectedLanes(outcome),
      ['budgetRequired', 'chatPlaidRequired', 'evidenceRequired', 'onboardingRequired', 'storekitRequired'],
      scope,
    );
    assert.equal(outcome.incomeRequired, false, scope);
    assert.equal(outcome.summary, 'Manual run requested iOS checks.');
  }
});

test('the PR-scoped evidence dispatches refuse to run without a pull request number', () => {
  for (const scope of ['shared-cta-evidence', 'financial-independence-evidence']) {
    for (const prNumber of ['', '0', 'abc', '1.0', ' 4992', '4992 ', '-1']) {
      const decision = manualDispatchDecision(scope, prNumber);
      assert.equal(decision.kind, 'error', `${scope} ${JSON.stringify(prNumber)}`);
      if (decision.kind !== 'error') continue;
      assert.equal(decision.message, `${scope} requires pull_request_number.`);
    }
    assert.match(decidedOutcome(scope, '4992').summary, /PR #4992\./);
  }
  // The unscoped lanes never read the number, so they must not start to.
  assert.equal(manualDispatchDecision('e2e', '').kind, 'outcome');
  assert.equal(manualDispatchDecision('evidence', 'abc').kind, 'outcome');
});

test('a pull request number must be a plain positive integer', () => {
  for (const value of ['1', '42', '4992']) assert.equal(isPositiveInteger(value), true, value);
  for (const value of ['', '0', '01', '-1', '1.0', ' 1', '1 ', '1e3', '+1', '1\n2']) {
    assert.equal(isPositiveInteger(value), false, JSON.stringify(value));
  }
});

test('a SHA is forty lowercase hex characters and nothing else', () => {
  assert.equal(isSha40(checkpointSha), true);
  for (const value of ['a'.repeat(39), 'a'.repeat(41), 'A'.repeat(40), `${'a'.repeat(40)}\n`, 42, null, undefined]) {
    assert.equal(isSha40(value), false, String(value));
  }
});

function dispatchPullRequest(overrides: Record<string, unknown> = {}): unknown {
  return {
    state: 'open',
    draft: false,
    head: { sha: headSha, repo: { full_name: repository } },
    base: { ref: 'develop', sha: baseSha },
    ...overrides,
  };
}

test('a PR-backed dispatch adopts an open same-repository head and nothing else', () => {
  const adopted = verifiedDispatchPullRequest(dispatchPullRequest(), repository, headSha);
  assert.deepEqual(adopted, {
    headSha,
    headRepository: repository,
    baseSha,
    baseBranch: 'develop',
  });
  assert.equal(
    verifiedDispatchPullRequest(dispatchPullRequest({ base: { ref: 'main', sha: baseSha } }), repository, headSha)
      ?.baseBranch,
    'main',
  );
});

test('a PR-backed dispatch is refused on every way its identity can drift', () => {
  const rejected: [string, unknown][] = [
    ['closed', dispatchPullRequest({ state: 'closed' })],
    ['draft', dispatchPullRequest({ draft: true })],
    ['draft absent', dispatchPullRequest({ draft: undefined })],
    ['fork head', dispatchPullRequest({ head: { sha: headSha, repo: { full_name: 'outside/fork' } } })],
    ['detached head repo', dispatchPullRequest({ head: { sha: headSha, repo: null } })],
    ['head moved', dispatchPullRequest({ head: { sha: 'd'.repeat(40), repo: { full_name: repository } } })],
    ['unprotected base', dispatchPullRequest({ base: { ref: 'feature/x', sha: baseSha } })],
    ['short base sha', dispatchPullRequest({ base: { ref: 'develop', sha: 'b'.repeat(39) } })],
    ['uppercase base sha', dispatchPullRequest({ base: { ref: 'develop', sha: 'B'.repeat(40) } })],
    ['not an object', 'open'],
    ['null', null],
  ];
  for (const [reason, body] of rejected) {
    assert.equal(verifiedDispatchPullRequest(body, repository, headSha), null, reason);
  }
});

function eventPullRequest(overrides: Record<string, unknown> = {}): unknown {
  return {
    state: 'open',
    base: { ref: 'develop', sha: baseSha },
    head: { ref: 'feature/x', sha: headSha, repo: { full_name: repository } },
    ...overrides,
  };
}

const eventIdentity = {
  baseBranch: 'develop',
  baseSha,
  headBranch: 'feature/x',
  headSha,
  headRepository: repository,
};

test('a pull request that moved after the event no longer owns this run', () => {
  assert.equal(pullRequestStillMatchesEvent(eventPullRequest(), eventIdentity), true);
  const drifted: [string, unknown][] = [
    ['merged', eventPullRequest({ state: 'closed' })],
    ['retargeted', eventPullRequest({ base: { ref: 'main', sha: baseSha } })],
    ['rebased base', eventPullRequest({ base: { ref: 'develop', sha: 'd'.repeat(40) } })],
    ['renamed head', eventPullRequest({ head: { ref: 'feature/y', sha: headSha, repo: { full_name: repository } } })],
    ['new head commit', eventPullRequest({ head: { ref: 'feature/x', sha: 'd'.repeat(40), repo: { full_name: repository } } })],
    ['moved to a fork', eventPullRequest({ head: { ref: 'feature/x', sha: headSha, repo: { full_name: 'outside/fork' } } })],
    ['unreadable body', undefined],
  ];
  for (const [reason, body] of drifted) {
    assert.equal(pullRequestStillMatchesEvent(body, eventIdentity), false, reason);
  }
});

test('only the checkpoint app may open a production promotion', () => {
  const user = { login: 'example-promotion-checkpoint[bot]', id: 324658254, type: 'Bot' };
  assert.equal(isCheckpointAppPullRequest({ user }), true);
  for (const [reason, replacement] of [
    ['a person', { login: 'example-user', id: 16886764, type: 'User' }],
    ['the right name with another id', { ...user, id: 1 }],
    ['the right id as a user', { ...user, type: 'User' }],
    ['no user', null],
  ] as [string, unknown][]) {
    assert.equal(isCheckpointAppPullRequest({ user: replacement }), false, reason);
  }
  assert.equal(isCheckpointAppPullRequest('nonsense'), false);
});

test('a draft promotion checkpoint idles instead of running or failing', () => {
  assert.equal(isDraftPullRequest({ draft: true }), true);
  assert.equal(isDraftPullRequest({ draft: false }), false);
  assert.equal(isDraftPullRequest({}), false);
  assert.equal(isDraftPullRequest({ draft: 'true' }), false);
  const idle = draftPromotionOutcome();
  assert.equal(idle.shouldRun, 'false');
  assert.equal(idle.needsCheckout, false);
  assert.equal(idle.productionPromotion, false);
});

test('a promotion is admitted only from this repository, the app, and out of draft', () => {
  const checkpointApp = { login: 'example-promotion-checkpoint[bot]', id: 324658254, type: 'Bot' };
  const ready = { user: checkpointApp, draft: false };
  assert.deepEqual(promotionAdmission(ready, repository, repository), { kind: 'continue' });

  // A fork can open a pull request against main, and its head is content
  // nobody with write access has approved, so it is refused before anything
  // about the checkpoint is read.
  assert.deepEqual(promotionAdmission(ready, 'outside/fork', repository), {
    kind: 'error',
    message: 'main only accepts production promotion checkpoints from this repository',
  });
  assert.deepEqual(
    promotionAdmission({ user: { login: 'example-user', id: 16886764, type: 'User' } }, repository, repository),
    {
      kind: 'error',
      message: 'main only accepts production promotion pull requests created by the checkpoint app',
    },
  );

  const draft = promotionAdmission({ user: checkpointApp, draft: true }, repository, repository);
  assert.equal(draft.kind, 'outcome');
  if (draft.kind !== 'outcome') return;
  assert.equal(draft.outcome.shouldRun, 'false');
  assert.equal(draft.outcome.needsCheckout, false);
  assert.match(draft.outcome.summary, /Draft production checkpoint is idle/);

  // Repository admission is checked before authorship, so a fork that manages
  // to look like the app is still refused for the reason that matters.
  assert.equal(promotionAdmission(ready, 'outside/fork', repository).kind, 'error');
});

test('only an exact promotion branch names a frozen checkpoint', () => {
  assert.equal(promotionCheckpointSha(branch), checkpointSha);
  for (const candidate of [
    'codex/promotion-20260908',
    'develop',
    `promotion/develop-${'a'.repeat(39)}`,
    `promotion/develop-${'a'.repeat(40)}-extra`,
    `promotion/develop-${'A'.repeat(40)}`,
    ` promotion/develop-${'a'.repeat(40)}`,
    `promotion/develop-${'a'.repeat(40)}\npromotion/develop-${'b'.repeat(40)}`,
  ]) {
    assert.equal(promotionCheckpointSha(candidate), null, candidate);
  }
});

test('a checkpoint must be develop itself or one of its ancestors', () => {
  for (const status of ['ahead', 'identical']) {
    assert.equal(
      checkpointIsOnDevelop({ status, merge_base_commit: { sha: checkpointSha } }, checkpointSha),
      true,
      status,
    );
  }
  for (const [reason, body] of [
    ['behind', { status: 'behind', merge_base_commit: { sha: checkpointSha } }],
    ['diverged', { status: 'diverged', merge_base_commit: { sha: checkpointSha } }],
    ['another merge base', { status: 'ahead', merge_base_commit: { sha: 'd'.repeat(40) } }],
    ['no merge base', { status: 'ahead' }],
    ['unreadable', 42],
  ] as [string, unknown][]) {
    assert.equal(checkpointIsOnDevelop(body, checkpointSha), false, reason);
  }
});

test('ordered main ancestry accepts only a strictly earlier base', () => {
  assert.equal(mainAncestryAdvances({ status: 'ahead', merge_base_commit: { sha: baseSha } }, baseSha), true);
  for (const [reason, body] of [
    ['identical', { status: 'identical', merge_base_commit: { sha: baseSha } }],
    ['behind', { status: 'behind', merge_base_commit: { sha: baseSha } }],
    ['diverged', { status: 'diverged', merge_base_commit: { sha: '0'.repeat(40) } }],
    ['other merge base', { status: 'ahead', merge_base_commit: { sha: 'd'.repeat(40) } }],
  ] as [string, unknown][]) {
    assert.equal(mainAncestryAdvances(body, baseSha), false, reason);
  }
});

test('a merge base is only accepted as a full SHA', () => {
  assert.equal(mergeBaseSha({ merge_base_commit: { sha: baseSha } }), baseSha);
  for (const body of [
    { merge_base_commit: { sha: 'b'.repeat(39) } },
    { merge_base_commit: { sha: '' } },
    { merge_base_commit: {} },
    {},
    null,
  ]) {
    assert.equal(mergeBaseSha(body), null, JSON.stringify(body));
  }
});

interface UpdateCommitOptions {
  readonly sha?: string;
  readonly firstParent?: string;
  readonly baseParent?: string;
  readonly headBranch?: string;
  readonly tree?: string;
  readonly verified?: boolean;
  readonly parents?: readonly { readonly sha: string }[];
  readonly message?: string;
  readonly committer?: { readonly login: string; readonly id: number } | null;
  readonly signature?: unknown;
}

function updateCommit(options: UpdateCommitOptions = {}): unknown {
  const sha = options.sha ?? headSha;
  const firstParent = options.firstParent ?? checkpointSha;
  const baseParent = options.baseParent ?? baseSha;
  const verified = options.verified ?? true;
  return {
    sha,
    parents: options.parents ?? [{ sha: firstParent }, { sha: baseParent }],
    commit: {
      message: options.message ?? `Merge branch 'main' into ${options.headBranch ?? branch}`,
      committer: { name: 'GitHub', email: 'noreply@github.com' },
      verification: {
        verified,
        reason: verified ? 'valid' : 'unsigned',
        signature: 'signature' in options ? options.signature : verified ? 'signature' : null,
      },
      tree: { sha: options.tree ?? defaultTree },
    },
    committer: options.committer === undefined ? { login: 'web-flow', id: 19864447 } : options.committer,
  };
}

const canonicalExpectation = { sha: headSha, message: `Merge branch 'main' into ${branch}` };

test('a canonical update commit yields its parents and tree', () => {
  assert.deepEqual(canonicalPromotionUpdateCommit(updateCommit(), canonicalExpectation), {
    firstParent: checkpointSha,
    updateBase: baseSha,
    tree: defaultTree,
  });
});

test('a promotion update commit without GitHub provenance is refused', () => {
  const refused: [string, unknown][] = [
    ['resolved to another commit', updateCommit({ sha: 'd'.repeat(40) })],
    ['single parent', updateCommit({ parents: [{ sha: checkpointSha }] })],
    ['three parents', updateCommit({ parents: [{ sha: checkpointSha }, { sha: baseSha }, { sha: 'e'.repeat(40) }] })],
    ['short parent', updateCommit({ parents: [{ sha: 'a'.repeat(39) }, { sha: baseSha }] })],
    ['unsigned', updateCommit({ verified: false })],
    ['signature absent', updateCommit({ signature: null })],
    ['empty signature', updateCommit({ signature: '' })],
    ['non-string signature', updateCommit({ signature: 1 })],
    ['local merge message', updateCommit({ message: 'Merge main with local changes' })],
    ['another branch in the message', updateCommit({ headBranch: `promotion/develop-${'e'.repeat(40)}` })],
    ['a person as committer', updateCommit({ committer: { login: 'example-user', id: 16886764 } })],
    ['web-flow name with another id', updateCommit({ committer: { login: 'web-flow', id: 1 } })],
    ['no committer', updateCommit({ committer: null })],
    ['short tree', updateCommit({ tree: 'f'.repeat(39) })],
    ['unreadable body', undefined],
  ];
  for (const [reason, body] of refused) {
    assert.equal(canonicalPromotionUpdateCommit(body, canonicalExpectation), null, reason);
  }
});

test('a verified commit signed only by reason is still refused', () => {
  const body = updateCommit();
  const typed = body as { commit: { verification: { reason: string } } };
  typed.commit.verification.reason = 'valid_but_expired';
  assert.equal(canonicalPromotionUpdateCommit(body, canonicalExpectation), null);
});

interface ChainFixture {
  readonly commits?: Record<string, unknown>;
  readonly commitStatus?: Record<string, string>;
  readonly unreachableCommits?: readonly string[];
  readonly mergeTrees?: Record<string, string>;
  readonly lineageAdvances?: boolean;
  readonly unreachableCompares?: readonly string[];
  readonly compareStatus?: Record<string, string>;
  readonly unfetchable?: readonly string[];
  readonly cleanMerge?: boolean;
  readonly mergeBaseOverride?: string;
  readonly validVersionChange?: boolean;
  readonly validVersionAttestation?: boolean;
  readonly validBareCheckpointVersion?: boolean;
}

function chainReaders(fixture: ChainFixture): PromotionChainReaders {
  return {
    readCommit: async (sha): Promise<GateApiOutcome> => {
      if (fixture.unreachableCommits?.includes(sha) === true) return { kind: 'unreachable' };
      const status = fixture.commitStatus?.[sha];
      if (status !== undefined) return { kind: 'response', statusLabel: status, body: undefined };
      const body = fixture.commits?.[sha];
      if (body === undefined) return { kind: 'response', statusLabel: '404', body: undefined };
      return { kind: 'response', statusLabel: '200', body };
    },
    compare: async (from, to): Promise<GateApiOutcome> => {
      const key = `${from}...${to}`;
      if (fixture.unreachableCompares?.includes(key) === true) return { kind: 'unreachable' };
      const status = fixture.compareStatus?.[key];
      if (status !== undefined) return { kind: 'response', statusLabel: status, body: undefined };
      return {
        kind: 'response',
        statusLabel: '200',
        body: {
          status: fixture.lineageAdvances === false ? 'diverged' : 'ahead',
          merge_base_commit: { sha: fixture.mergeBaseOverride ?? from },
        },
      };
    },
    fetchObject: async (sha) => fixture.unfetchable?.includes(sha) !== true,
    mergeTree: async (_base, left, right) => (
      fixture.cleanMerge === false ? null : fixture.mergeTrees?.[`${left}:${right}`] ?? defaultTree
    ),
    verifyVersionChange: async () => fixture.validVersionChange === true,
    verifyVersionAttestation: async () => fixture.validVersionAttestation === true,
    verifyBareCheckpointVersion: async () => fixture.validBareCheckpointVersion !== false,
  };
}

const chainInput = { headSha, headBranch: branch, baseSha, checkpointSha };

async function chainError(fixture: ChainFixture, input = chainInput): Promise<string> {
  const result = await verifyPromotionUpdateChain(input, chainReaders(fixture));
  assert.equal(result.kind, 'error', 'the chain must have been refused');
  return result.kind === 'error' ? result.message : '';
}

test('one canonical update between the checkpoint and main is accepted', async () => {
  const result = await verifyPromotionUpdateChain(chainInput, chainReaders({
    commits: { [headSha]: updateCommit() },
  }));
  assert.deepEqual(result, { kind: 'verified' });
});

test('a canonical update from a reset bare checkpoint still requires its App source-version attestation', async () => {
  const message = await chainError({
    commits: { [headSha]: updateCommit() },
    validBareCheckpointVersion: false,
  });
  assert.match(message, /lacks a trusted checkpoint App source-version attestation/);
});

test('one deterministic version-only commit is accepted before the canonical update', async () => {
  const versionSha = 'f'.repeat(40);
  const result = await verifyPromotionUpdateChain(chainInput, chainReaders({
    commits: {
      [headSha]: updateCommit({ firstParent: versionSha }),
      [versionSha]: {
        sha: versionSha,
        parents: [{ sha: checkpointSha }],
        commit: { message: 'chore(ios): set promotion marketing version to 1.5.2' },
      },
    },
    validVersionChange: true,
    validVersionAttestation: true,
  }));
  assert.deepEqual(result, { kind: 'verified' });
});

test('a version-only writer commit without a checkpoint App attestation is refused', async () => {
  const versionSha = 'f'.repeat(40);
  const result = await chainError({
    commits: {
      [headSha]: updateCommit({ firstParent: versionSha }),
      [versionSha]: {
        sha: versionSha,
        parents: [{ sha: checkpointSha }],
        commit: { message: 'chore(ios): set promotion marketing version to 999.0.0' },
      },
    },
    validVersionChange: true,
  });
  assert.match(result, /lacks a trusted checkpoint App attestation/);
});

test('version commit is rejected when it changes anything besides marketing version', async () => {
  const result = await chainError({
    commits: {
      [headSha]: {
        sha: headSha,
        parents: [{ sha: checkpointSha }],
        commit: { message: 'chore(ios): set promotion marketing version to 1.5.2' },
      },
    },
  });
  assert.match(result, /changes more than the iOS marketing version/);
});

test('a promotion head that is not a GitHub update of current main is refused', async () => {
  const cases: [string, ChainFixture, RegExp][] = [
    [
      'arbitrary follow-up commit',
      { commits: { [headSha]: updateCommit({ parents: [{ sha: checkpointSha }] }) } },
      /lacks canonical GitHub provenance/,
    ],
    [
      'reversed parents',
      { commits: { [headSha]: updateCommit({ parents: [{ sha: baseSha }, { sha: checkpointSha }] }) } },
      /does not target current main/,
    ],
    [
      'stale base parent',
      { commits: { [headSha]: updateCommit({ baseParent: 'd'.repeat(40) }) } },
      /does not target current main/,
    ],
    [
      'extra parent',
      {
        commits: {
          [headSha]: updateCommit({ parents: [{ sha: checkpointSha }, { sha: baseSha }, { sha: 'e'.repeat(40) }] }),
        },
      },
      /lacks canonical GitHub provenance/,
    ],
    [
      'head commit metadata resolved elsewhere',
      { commits: { [headSha]: updateCommit({ sha: 'd'.repeat(40) }) } },
      /lacks canonical GitHub provenance/,
    ],
    [
      'unreadable head commit',
      { commits: {} },
      /Unexpected GitHub response while checking promotion update commit .*: HTTP 404\./,
    ],
    [
      'unreachable head commit',
      { unreachableCommits: [headSha] },
      /Could not verify promotion update commit/,
    ],
  ];
  for (const [reason, fixture, expected] of cases) {
    assert.match(await chainError(fixture), expected, reason);
  }
});

test('a signed two-parent commit carrying an arbitrary tree is refused', async () => {
  const message = await chainError({
    commits: { [headSha]: updateCommit({ tree: 'd'.repeat(40) }) },
    mergeTrees: { [`${checkpointSha}:${baseSha}`]: defaultTree },
  });
  assert.match(message, /tree does not match the canonical merge of its parents\./);
});

test('a head that does not reproduce as a clean git merge is refused', async () => {
  const message = await chainError({ commits: { [headSha]: updateCommit() }, cleanMerge: false });
  assert.match(message, /does not reproduce as a clean git merge\./);
});

test('a merge object that cannot be fetched fails the proof closed', async () => {
  for (const object of [checkpointSha, baseSha]) {
    const message = await chainError({ commits: { [headSha]: updateCommit() }, unfetchable: [object] });
    assert.equal(message, `Could not fetch exact promotion merge object ${object}.`);
  }
});

test('a merge base that is not a full SHA fails the proof closed', async () => {
  const message = await chainError({
    commits: { [headSha]: updateCommit() },
    mergeBaseOverride: 'not-a-sha',
  });
  assert.match(message, /Could not read a merge base commit for promotion update/);
});

test('an unusable merge-base comparison is reported rather than assumed', async () => {
  const unreachable = await chainError({
    commits: { [headSha]: updateCommit() },
    unreachableCompares: [`${checkpointSha}...${baseSha}`],
  });
  assert.match(unreachable, /Could not determine merge base for promotion update/);
  const refused = await chainError({
    commits: { [headSha]: updateCommit() },
    compareStatus: { [`${checkpointSha}...${baseSha}`]: '502' },
  });
  assert.equal(refused, 'Unexpected GitHub response while finding promotion merge base: HTTP 502.');
});

const oldBase = 'd'.repeat(40);
const priorHead = 'e'.repeat(40);
const repeatedChainCommits = {
  [headSha]: updateCommit({ sha: headSha, firstParent: priorHead, baseParent: baseSha, tree: '1'.repeat(40) }),
  [priorHead]: updateCommit({ sha: priorHead, firstParent: checkpointSha, baseParent: oldBase, tree: '2'.repeat(40) }),
};
const repeatedChainTrees = {
  [`${priorHead}:${baseSha}`]: '1'.repeat(40),
  [`${checkpointSha}:${oldBase}`]: '2'.repeat(40),
};

test('a bounded verified chain across repeated main advances is accepted', async () => {
  const result = await verifyPromotionUpdateChain(chainInput, chainReaders({
    commits: repeatedChainCommits,
    mergeTrees: repeatedChainTrees,
  }));
  assert.deepEqual(result, { kind: 'verified' });
});

test('a repeated chain with stale or reordered main ancestry is refused', async () => {
  const message = await chainError({
    commits: repeatedChainCommits,
    mergeTrees: repeatedChainTrees,
    lineageAdvances: false,
  });
  assert.equal(message, 'Promotion update chain contains stale, repeated, or reordered main ancestry.');
  const unreachable = await chainError({
    commits: repeatedChainCommits,
    mergeTrees: repeatedChainTrees,
    unreachableCompares: [`${oldBase}...${baseSha}`],
  });
  assert.match(unreachable, /Could not verify ordered main ancestry for promotion update/);
});

test('an extra-parent or unsigned commit deeper in a chain is refused', async () => {
  for (const older of [
    updateCommit({
      sha: priorHead,
      parents: [{ sha: checkpointSha }, { sha: oldBase }, { sha: '9'.repeat(40) }],
      tree: '2'.repeat(40),
    }),
    updateCommit({ sha: priorHead, firstParent: checkpointSha, baseParent: oldBase, tree: '2'.repeat(40), verified: false }),
  ]) {
    const message = await chainError({
      commits: { [headSha]: repeatedChainCommits[headSha], [priorHead]: older },
      mergeTrees: repeatedChainTrees,
    });
    assert.match(message, /lacks canonical GitHub provenance/);
  }
});

test('a chain longer than the bound is refused instead of walked forever', async () => {
  // Every commit is a canonical update of the one before it, and none of them
  // is ever the checkpoint, so only the bound can stop the walk.
  const commits: Record<string, unknown> = {};
  const mergeTrees: Record<string, string> = {};
  let current = headSha;
  let currentBase = baseSha;
  for (let depth = 0; depth <= promotionUpdateChainLimit + 2; depth += 1) {
    const parent = `${String(depth).padStart(2, '0')}${'9'.repeat(38)}`;
    const parentBase = `${String(depth).padStart(2, '0')}${'8'.repeat(38)}`;
    commits[current] = updateCommit({ sha: current, firstParent: parent, baseParent: currentBase });
    mergeTrees[`${parent}:${currentBase}`] = defaultTree;
    current = parent;
    currentBase = parentBase;
  }
  const message = await chainError({ commits, mergeTrees });
  assert.equal(
    message,
    `Promotion update chain did not reach checkpoint ${checkpointSha} within ${promotionUpdateChainLimit} verified updates.`,
  );
});

test('the two routing outcomes carry the checkout flag the later steps gate on', () => {
  const routing = changedFileRoutingOutcome();
  assert.equal(routing.shouldRun, '');
  assert.equal(routing.needsCheckout, true);
  assert.equal(routing.productionPromotion, false);
  const promotion = productionPromotionOutcome();
  assert.equal(promotion.shouldRun, 'true');
  assert.equal(promotion.needsCheckout, true);
  assert.equal(promotion.productionPromotion, true);
  assert.deepEqual(selectedLanes(promotion), ['onboardingRequired', 'productionPromotion']);
});

test('a proved promotion pins typed verdicts to its develop checkpoint while retaining the main tuple base', () => {
  const promotion = productionPromotionOutcome();
  assert.equal(trustedVerifierRevision(promotion, branch, baseSha, headSha), checkpointSha);
  assert.notEqual(checkpointSha, baseSha);
  assert.throws(
    () => trustedVerifierRevision(promotion, 'promotion/develop-invalid', baseSha, headSha),
    /no valid develop checkpoint/,
  );
  assert.equal(trustedVerifierRevision(changedFileRoutingOutcome(), 'feature', baseSha, headSha), baseSha);
  assert.equal(trustedVerifierRevision(changedFileRoutingOutcome(), '', '', headSha), headSha);
});

test('an admitted promotion-evidence dispatch pins verdicts to exact develop instead of main', () => {
  const dispatch = decidedOutcome('promotion-evidence', '');
  assert.equal(trustedVerifierRevision(dispatch, 'develop', baseSha, headSha, 'promotion-evidence'), headSha);
  assert.notEqual(headSha, baseSha);
  assert.equal(trustedVerifierRevision(decidedOutcome('e2e', ''), 'develop', baseSha, headSha, 'e2e'), baseSha);
  assert.throws(() => trustedVerifierRevision(changedFileRoutingOutcome(), 'develop', baseSha,
    headSha, 'promotion-evidence'), /no admitted exact develop verifier/);
  assert.throws(() => trustedVerifierRevision(dispatch, 'develop', baseSha,
    'invalid', 'promotion-evidence'), /no admitted exact develop verifier/);
});
