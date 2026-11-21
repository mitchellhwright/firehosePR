import {
  canonicalPromotionUpdateCommit, isSha40,
} from '../ios/iosGatePrecheck.ts';
import { CheckpointApi, type CheckpointPull } from './checkpointApi.ts';
import {
  marketingVersionCommitPrefix, marketingVersionProjectPath,
  marketingVersionExceeds, readMarketingVersion, rewriteMarketingVersion, versionFromCommitMessage,
} from './marketingVersion.ts';
import {
  hasTrustedVersionAttestation, versionAttestationBody, type VersionAttestation,
} from './versionAttestation.ts';

const maxUpdateAttempts = 4;
const maxPolls = 30;
const maxLineageDepth = 32;

export interface CheckpointInput {
  readonly repository: string;
  readonly repositoryOwner: string;
  readonly originalNumber: number;
  readonly sourceSha: string;
  readonly sourceVersion: string;
  readonly marketingVersion: string;
  /** The App-attested selection from a prior attempt, if one exists. */
  readonly selectedCommitSha: string | null;
}

export interface CheckpointResult {
  readonly branch: string;
  readonly number: number;
  readonly url: string;
  readonly headSha: string;
  readonly baseSha: string;
}

export interface CheckpointTransactionOptions {
  readonly sleep?: (milliseconds: number) => Promise<void>;
  readonly log?: (message: string) => void;
  readonly warn?: (message: string) => void;
}

function assertSource(pull: CheckpointPull, input: CheckpointInput, originalDraft?: boolean): void {
  if (pull.state !== 'open' || pull.base.ref !== 'main'
    || pull.head.ref !== 'develop' || pull.head.repo.full_name !== input.repository
    || pull.head.sha !== input.sourceSha
    || (originalDraft !== undefined && pull.draft !== originalDraft)) {
    throw new Error('The mutable promotion PR no longer matches this event; a newer event must create the checkpoint.');
  }
}

function assertCheckpoint(
  pull: CheckpointPull, repository: string, branch: string,
  headSha?: string, baseSha?: string, draft?: boolean,
): void {
  if (pull.state !== 'open' || pull.base.ref !== 'main'
    || pull.head.ref !== branch || pull.head.repo.full_name !== repository
    || (headSha !== undefined && pull.head.sha !== headSha)
    || (baseSha !== undefined && pull.base.sha !== baseSha)
    || (draft !== undefined && pull.draft !== draft)) {
    throw new Error('The checkpoint pull request changed while proving its exact head/base tuple.');
  }
}

function githubMessage(body: unknown): string {
  if (typeof body !== 'object' || body === null || !('message' in body)) return 'unknown GitHub response';
  return typeof body.message === 'string' ? body.message : 'unknown GitHub response';
}

async function ensureAttestation(
  api: CheckpointApi, number: number, attestation: VersionAttestation,
): Promise<void> {
  if (hasTrustedVersionAttestation(await api.comments(number), attestation)) return;
  const posted = await api.comment(number, versionAttestationBody(attestation));
  if (!hasTrustedVersionAttestation([posted], attestation)) {
    throw new Error(`The checkpoint App did not confirm its version attestation on PR #${number}.`);
  }
}

async function proveLineage(
  api: CheckpointApi,
  branch: string,
  sourceSha: string,
  sourceVersion: string,
  marketingVersion: string,
  candidateHead: string,
  requiredLatestBase?: string,
): Promise<string | null> {
  let current = candidateHead;
  let expectedNewerBase = requiredLatestBase;
  for (let depth = 1; depth <= maxLineageDepth; depth += 1) {
    if (current === sourceSha) {
      if (sourceVersion === marketingVersion) return null;
      throw new Error('Promotion checkpoint lacks its version-only commit.');
    }
    const body = await api.commit(current);
    const canonical = canonicalPromotionUpdateCommit(body, {
      sha: current,
      message: `Merge branch 'main' into ${branch}`,
    });
    if (canonical === null) {
      const version = versionFromCommitMessage(body.commit.message);
      if (version !== marketingVersion || body.parents.length !== 1
        || body.parents[0]?.sha !== sourceSha
        || body.files?.length !== 1
        || body.files[0]?.filename !== marketingVersionProjectPath
        || body.files[0]?.status !== 'modified') {
        throw new Error(`Checkpoint commit ${current} is neither a canonical GitHub Update Branch merge nor the exact version-only commit.`);
      }
      const [sourceFile, versionFile] = await Promise.all([
        api.readFile(marketingVersionProjectPath, sourceSha),
        api.readFile(marketingVersionProjectPath, current),
      ]);
      if (rewriteMarketingVersion(sourceFile, marketingVersion) !== versionFile) {
        throw new Error(`Checkpoint version commit ${current} changes more than the expected iOS marketing version.`);
      }
      return current;
    }
    if (expectedNewerBase !== undefined) {
      if (depth === 1) {
        if (canonical.updateBase !== expectedNewerBase) {
          throw new Error(`Checkpoint update ${current} targets ${canonical.updateBase}, expected current main ${expectedNewerBase}.`);
        }
      } else {
        const compared = await api.compare(canonical.updateBase, expectedNewerBase);
        if ((compared.status !== 'ahead' && compared.status !== 'identical')
          || compared.merge_base_commit?.sha !== canonical.updateBase) {
          throw new Error(`Checkpoint update ${current} does not follow ordered main ancestry.`);
        }
      }
    }
    expectedNewerBase = canonical.updateBase;
    current = canonical.firstParent;
  }
  throw new Error(`Checkpoint update chain did not reach source commit ${sourceSha} within ${maxLineageDepth} commits.`);
}

async function snapshot(
  api: CheckpointApi, number: number, branch: string,
): Promise<{ readonly pull: CheckpointPull; readonly head: string; readonly main: string }> {
  const [pull, head, main] = await Promise.all([
    api.pull(number), api.ref(branch), api.ref('main'),
  ]);
  if (head === null || main === null) throw new Error('GitHub did not return the checkpoint or main ref.');
  return { pull, head, main };
}

async function stableSnapshot(
  api: CheckpointApi, number: number, branch: string, repository: string,
  head: string, base: string, draft: boolean,
): Promise<boolean> {
  const next = await snapshot(api, number, branch);
  try {
    assertCheckpoint(next.pull, repository, branch, head, base, draft);
  } catch {
    return false;
  }
  return next.head === head && next.main === base;
}

async function proveCurrentCheckpoint(
  api: CheckpointApi,
  input: CheckpointInput,
  branch: string,
  number: number,
  sleep: (milliseconds: number) => Promise<void>,
  log: (message: string) => void,
): Promise<{ readonly head: string; readonly base: string }> {
  for (let attempt = 1; attempt <= maxUpdateAttempts; attempt += 1) {
    const current = await snapshot(api, number, branch);
    try {
      assertCheckpoint(current.pull, input.repository, branch, current.head, current.main, true);
    } catch {
      log(`Checkpoint refs changed while reading attempt ${attempt}; retrying the bounded proof.`);
      continue;
    }
    await proveLineage(api, branch, input.sourceSha, input.sourceVersion, input.marketingVersion, current.head);

    if (current.head !== input.sourceSha) {
      const tip = await api.commit(current.head);
      if (tip.parents[1]?.sha === current.main) {
        await proveLineage(api, branch, input.sourceSha, input.sourceVersion, input.marketingVersion, current.head, current.main);
        if (await stableSnapshot(api, number, branch, input.repository, current.head, current.main, true)) {
          return { head: current.head, base: current.main };
        }
        log(`Current main advanced while recovering checkpoint proof attempt ${attempt}; retrying while draft.`);
        continue;
      }
    }

    const update = await api.updateBranch(number, current.head);
    if (update.status === 422 && githubMessage(update.body) === 'There are no new commits on the base branch.') {
      const noOp = await snapshot(api, number, branch);
      if (noOp.main !== current.main) {
        log(`Current main advanced during checkpoint no-op proof attempt ${attempt}; retrying while draft.`);
        continue;
      }
      assertCheckpoint(noOp.pull, input.repository, branch, current.head, current.main, true);
      if (noOp.head !== current.head) {
        throw new Error('GitHub reported no base commits, but the checkpoint head/base tuple was not stable.');
      }
      const compared = await api.compare(current.main, current.head);
      if ((compared.status !== 'ahead' && compared.status !== 'identical')
        || compared.base_commit?.sha !== current.main
        || compared.merge_base_commit?.sha !== current.main
        || compared.behind_by !== 0) {
        throw new Error(`GitHub reported no base commits, but checkpoint head ${current.head} does not contain current main ${current.main}.`);
      }
      return { head: current.head, base: current.main };
    }
    if (update.status !== 202) {
      throw new Error(`GitHub Update Branch failed for draft checkpoint #${number}: HTTP ${update.status}: ${githubMessage(update.body)}`);
    }

    let updatedHead: string | null = null;
    for (let poll = 0; poll < maxPolls; poll += 1) {
      const polled = await api.pull(number);
      if (polled.head.sha !== current.head) {
        updatedHead = polled.head.sha;
        break;
      }
      await sleep(2_000);
    }
    if (updatedHead === null) {
      throw new Error('GitHub Update Branch did not publish a new checkpoint head within 60 seconds.');
    }
    await proveLineage(api, branch, input.sourceSha, input.sourceVersion, input.marketingVersion, updatedHead);
    const updatedCommit = await api.commit(updatedHead);
    const updatedBase = updatedCommit.parents[1]?.sha;
    const final = await snapshot(api, number, branch);
    assertCheckpoint(final.pull, input.repository, branch, updatedHead, undefined, true);
    if (final.head !== updatedHead) throw new Error('The checkpoint head or ref drifted after GitHub Update Branch.');
    if (final.main !== current.main) {
      log(`Current main advanced during checkpoint proof attempt ${attempt}; retrying while draft.`);
      continue;
    }
    if (updatedBase !== current.main || final.pull.base.sha !== current.main) {
      throw new Error(`GitHub Update Branch returned a base tuple that does not match stable current main ${current.main}.`);
    }
    await proveLineage(api, branch, input.sourceSha, input.sourceVersion, input.marketingVersion, updatedHead, current.main);
    return { head: updatedHead, base: current.main };
  }
  throw new Error(`Could not prove a canonical checkpoint update against stable current main after ${maxUpdateAttempts} attempts.`);
}

async function compensate(
  api: CheckpointApi, nodeId: string | null, originalNumber: number,
  sourceClosed: boolean, warn: (message: string) => void,
): Promise<void> {
  if (nodeId !== null) {
    let restored = false;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        restored = (await api.setDraft(nodeId, true)).isDraft;
        if (restored) break;
      } catch { /* Retry a transient GitHub failure. */ }
    }
    if (!restored) warn('::error::The checkpoint transaction failed and GitHub did not confirm the replacement was returned to draft.');
  }
  if (sourceClosed) {
    let reopened = false;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        reopened = (await api.setPullState(originalNumber, 'open')).state === 'open';
        if (reopened) break;
      } catch { /* Retry a transient GitHub failure. */ }
    }
    if (!reopened) warn('::error::The checkpoint transaction failed after source closure and GitHub did not confirm the source was reopened.');
  }
}

export async function createImmutablePromotionCheckpoint(
  api: CheckpointApi,
  input: CheckpointInput,
  options: CheckpointTransactionOptions = {},
): Promise<CheckpointResult> {
  if (!isSha40(input.sourceSha) || !Number.isSafeInteger(input.originalNumber) || input.originalNumber < 1) {
    throw new Error('The promotion event needs an exact source SHA and pull request number.');
  }
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const log = options.log ?? console.log;
  const warn = options.warn ?? console.warn;
  const branch = `promotion/develop-${input.sourceSha}`;
  let nodeId: string | null = null;
  let sourceClosed = false;
  let complete = false;
  try {
    const original = await api.pull(input.originalNumber);
    assertSource(original, input);
    const originalDraft = original.draft;
    let checkpointVersionSha = input.selectedCommitSha;
    if (checkpointVersionSha !== null && !isSha40(checkpointVersionSha)) {
      throw new Error('The prior version selection does not name an exact commit.');
    }
    if (input.marketingVersion === input.sourceVersion) {
      if (checkpointVersionSha !== null && checkpointVersionSha !== input.sourceSha) {
        throw new Error('The prior unchanged version selection names a different commit.');
      }
      checkpointVersionSha = input.sourceSha;
      await ensureAttestation(api, input.originalNumber, {
        sourceSha: input.sourceSha, commitSha: checkpointVersionSha, version: input.marketingVersion,
      });
    }

    const existingRef = await api.ref(branch);
    if (existingRef !== null) {
      const recovered = await api.findCheckpoint(input.repositoryOwner, branch);
      if (recovered?.state === 'open') {
        nodeId = recovered.node_id;
        if (existingRef === input.sourceSha && input.marketingVersion !== input.sourceVersion) {
          throw new Error('Existing promotion PR still points to the unversioned source; refusing to revise a PR head after checks began.');
        }
        if (!recovered.draft) await api.setDraft(nodeId, true);
      }
      if (existingRef !== input.sourceSha) {
        const provenVersionSha = await proveLineage(
          api, branch, input.sourceSha, input.sourceVersion, input.marketingVersion, existingRef,
        );
        if (checkpointVersionSha !== (provenVersionSha ?? input.sourceSha)) {
          throw new Error('Existing checkpoint head does not match the App-attested source version commit.');
        }
      }
    } else {
      await api.createRef(branch, input.sourceSha);
    }

    if ((existingRef ?? input.sourceSha) === input.sourceSha && input.marketingVersion !== input.sourceVersion) {
      if (checkpointVersionSha === null) {
        const sourceFile = await api.readFile(marketingVersionProjectPath, input.sourceSha);
        // A malformed or mixed project version fails before writing any Git object.
        if (readMarketingVersion(sourceFile) !== input.sourceVersion) {
          throw new Error('The source iOS marketing version changed during promotion planning.');
        }
        const content = rewriteMarketingVersion(sourceFile, input.marketingVersion);
        const sourceTree = await api.treeForCommit(input.sourceSha);
        const blob = await api.createBlob(content);
        const tree = await api.createTree(sourceTree, marketingVersionProjectPath, blob);
        checkpointVersionSha = await api.createCommit(
          `${marketingVersionCommitPrefix}${input.marketingVersion}`, tree, input.sourceSha,
        );
      }
      await proveLineage(api, branch, input.sourceSha, input.sourceVersion, input.marketingVersion, checkpointVersionSha);
      // Attest on the original PR before moving the branch. A retry can then
      // recover this immutable commit even if Apple's live inventory changes.
      await ensureAttestation(api, input.originalNumber, {
        sourceSha: input.sourceSha, commitSha: checkpointVersionSha, version: input.marketingVersion,
      });
      await api.advanceRef(branch, checkpointVersionSha);
    }

    let checkpoint = await api.findCheckpoint(input.repositoryOwner, branch);
    if (checkpoint === null) {
      const body = `${original.body ?? ''}\n\n---\n\nPromotion checkpoint of \`develop\` at \`${input.sourceSha}\`.\n\n` +
        `iOS marketing version: \`${input.marketingVersion}\` ` +
        `(source: \`${input.sourceVersion}\`; selected from App Store Connect before this checkpoint PR opened).\n\n` +
        `Replaces #${input.originalNumber}. The \`${branch}\` branch is frozen after GitHub aligns it to the current \`main\`; later \`develop\` pushes do not change this PR or reset its exact-head evidence.`;
      checkpoint = await api.createPull(original.title, branch, body);
    } else if (checkpoint.state === 'closed') {
      checkpoint = await api.setPullState(checkpoint.number, 'open');
    }
    nodeId = checkpoint.node_id;
    assertCheckpoint(checkpoint, input.repository, branch);
    if (!checkpoint.draft) await api.setDraft(nodeId, true);

    if (checkpointVersionSha === null) throw new Error('The checkpoint has no App-attested iOS version selection.');
    await ensureAttestation(api, checkpoint.number, {
      sourceSha: input.sourceSha, commitSha: checkpointVersionSha, version: input.marketingVersion,
    });

    const proven = await proveCurrentCheckpoint(api, input, branch, checkpoint.number, sleep, log);
    const mainVersion = readMarketingVersion(await api.readFile(marketingVersionProjectPath, proven.base));
    if (!marketingVersionExceeds(input.marketingVersion, mainVersion)) {
      throw new Error(`Promotion version ${input.marketingVersion} must exceed current main version ${mainVersion}; the checkpoint stays draft.`);
    }
    assertSource(await api.pull(input.originalNumber), input, originalDraft);
    if (!originalDraft) {
      const ready = await api.setDraft(nodeId, false);
      if (ready.isDraft || ready.headSha !== proven.head || ready.baseSha !== proven.base || ready.baseRef !== 'main') {
        throw new Error('The ready transition did not retain the proven checkpoint base/head tuple.');
      }
    }

    const [closingOriginal, closing] = await Promise.all([
      api.pull(input.originalNumber),
      snapshot(api, checkpoint.number, branch),
    ]);
    assertSource(closingOriginal, input, originalDraft);
    assertCheckpoint(closing.pull, input.repository, branch, proven.head, proven.base, originalDraft);
    if (closing.head !== proven.head || closing.main !== proven.base) {
      throw new Error('The source or proven checkpoint tuple changed before source closure.');
    }
    await api.setPullState(input.originalNumber, 'closed');
    sourceClosed = true;
    const [closedOriginal, closed] = await Promise.all([
      api.pull(input.originalNumber), snapshot(api, checkpoint.number, branch),
    ]);
    if (closedOriginal.state !== 'closed') throw new Error('The mutable source did not remain closed.');
    if (closedOriginal.draft !== originalDraft || closedOriginal.head.sha !== input.sourceSha
      || closedOriginal.head.ref !== 'develop' || closedOriginal.head.repo.full_name !== input.repository
      || closedOriginal.base.ref !== 'main') {
      throw new Error('The source tuple changed during source closure.');
    }
    assertCheckpoint(closed.pull, input.repository, branch, proven.head, proven.base, originalDraft);
    if (closed.head !== proven.head || closed.main !== proven.base) {
      throw new Error('The proven checkpoint tuple changed during source closure.');
    }
    complete = true;
    sourceClosed = false;
    const labels = original.labels.map((label) => label.name);
    if (labels.length > 0) {
      try { await api.addLabels(checkpoint.number, labels); }
      catch { warn(`::warning::Checkpoint #${checkpoint.number} was proven and the source closed, but label copy failed.`); }
    }
    try {
      await api.comment(input.originalNumber,
        `Replaced by promotion checkpoint #${checkpoint.number} from \`${input.sourceSha}\`, proven at \`${proven.head}\` against current \`main\` \`${proven.base}\`. This mutable \`develop\` PR closed only after the draft checkpoint completed GitHub Update Branch provenance proof.`);
    } catch {
      warn(`::warning::Checkpoint #${checkpoint.number} was proven and the source closed, but the source comment failed.`);
    }
    return {
      branch, number: checkpoint.number, url: checkpoint.html_url,
      headSha: proven.head, baseSha: proven.base,
    };
  } catch (error: unknown) {
    if (!complete) await compensate(api, nodeId, input.originalNumber, sourceClosed, warn);
    throw error;
  }
}
