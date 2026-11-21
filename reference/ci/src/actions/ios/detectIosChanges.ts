import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { z } from 'zod';
import { readMergeGroupEvent } from '../../ciEvent.ts';
import { githubGitEnvironment } from '../../githubGit.ts';
import { readMergeGroupInventory } from '../../mergeGroupInventory.ts';
import { MergeQueueCandidateGone, queueCandidateGone } from '../../mergeQueueCandidateGone.ts';
import { createGithubRequester } from '../../ios/shared/githubRest.ts';
import { ensureIosMergeBase } from './ensureIosMergeBase.ts';
import { promotionChangedFiles } from '../../ios/promotionChangedFiles.ts';

import {
  candidateGoneOutputs,
  completeIosChangeDetection,
  detectEarlyExitOutputs,
  nativeSelectorChangedFiles,
  planIosChangeDetection,
  readSelectorDecision,
  selectorDecisionErrors,
  type GateContext,
} from '../../ios/iosChangeGate.ts';
import { fetchPullRequestChangedFiles } from '../../ios/shared/pullRequestFiles.ts';
import { StepFailure } from '../../ios/shared/stepFailure.ts';
import {
  appendStepOutputs,
  requiredEnv,
  runStep,
  type StepOutput,
} from '../../ios/shared/stepIo.ts';

/**
 * `ios-change-gate` → `Detect iOS Changes`.
 *
 * Decides whether iOS runs for this pull request and which lanes it runs, from
 * the pull request's changed files. All of the deciding lives in
 * `ci/src/ios/iosChangeGate.ts`; this program only reads the step's `env:`,
 * performs the three external reads (the changed-file inventory and the two
 * affected-test selector runs) and writes `$GITHUB_OUTPUT`.
 */

/**
 * The keys the gate job reads back off this step, in the order every write path
 * emits them. Three different paths build an output set — an early exit, a
 * retained-evidence or lane-only rerun, and the full classification — and a
 * consumer that reads a key one of them forgot gets an empty string with no
 * error, so each set is checked against this contract before it is published.
 */
const publishedOutputKeys = [
  'should_run',
  'storekit_required',
  'onboarding_required',
  'budget_required',
  'evidence_required',
  'main_required',
  'chat_plaid_required',
  'income_required',
  'rerun_ios_lanes',
  'changed_files',
  'native_changed_files',
  'native_changed_files_explicit_empty',
  'summary',
] as const;

function publish(outputs: readonly StepOutput[]): void {
  const written = outputs.map((output) => output.key);
  if (written.join(',') !== publishedOutputKeys.join(',')) {
    throw new StepFailure(
      `::error::Detect iOS Changes wrote [${written.join(', ')}] but the gate reads `
      + `[${publishedOutputKeys.join(', ')}].`,
    );
  }
  appendStepOutputs(outputs);
}

const environmentSchema = z.object({
  EVENT_NAME: z.string().default(''),
  GITHUB_BASE_REF: z.string().default(''),
  TEST_SCOPE: z.string().default(''),
  GITHUB_TOKEN: z.string().default(''),
  GITHUB_FALLBACK_TOKEN: z.string().default(''),
  PR_NUMBER: z.string().default(''),
  MERGE_GROUP_REF: z.string().default(''),
  IOS_CHANGE_DETECTOR_ROOT: z.string().default('.'),
  REPOSITORY: z.string().default(''),
  GITHUB_SERVER_URL: z.string().default('https://github.com'),
  RUNNER_TEMP: z.string().default(''),
  IOS_AFFECTED_TESTS_BASE: z.string().default(''),
  IOS_AFFECTED_TESTS_HEAD: z.string().default(''),
  CONTROLLER_BASE_UPDATE_VALID: z.string().default(''),
  CONTROLLER_BASE_UPDATE_SUPERSEDED: z.string().default(''),
  CONTROLLER_BASE_UPDATE_DEFERRED: z.string().default(''),
  CONTROLLER_BASE_UPDATE_REUSE_NATIVE_EVIDENCE: z.string().default(''),
  CONTROLLER_BASE_UPDATE_FILES: z.string().default(''),
  FORCED_IOS_AUXILIARY: z.string().default(''),
  FORCED_IOS_LANES: z.string().default(''),
  GITHUB_RUN_ID: z.string().default(''),
  GITHUB_API_URL: z.string().default('https://api.github.com'),
  GITHUB_RUN_ATTEMPT: z.string().default(''),
});

type Environment = z.infer<typeof environmentSchema>;

/** `sed -n 's/^key=//p' | tail -n 1`: the last line the selector wrote for that key. */
function lastSelectorValue(output: string, key: string): string {
  let value = '';
  for (const line of output.split('\n')) {
    if (line.startsWith(`${key}=`)) value = line.slice(key.length + 1);
  }
  return value;
}

interface SelectorRun {
  /** The checkout this detector runs from; its selector reads the workspace as data. */
  readonly detectorRoot: string;
  readonly lane: 'evidence' | 'main';
  readonly outputFile: string;
  readonly changedFiles: string;
  readonly storekitRequired?: string;
}

/**
 * Runs the affected-test selector into a scratch `$GITHUB_OUTPUT` so its
 * decisions can be read without them landing on this step's own outputs.
 */
function runAffectedTestSelector(run: SelectorRun): string {
  const outputPath = join(requiredEnv('RUNNER_TEMP'), run.outputFile);
  writeFileSync(outputPath, '', 'utf8');
  const selector = join(run.detectorRoot, 'scripts/select-ios-affected-tests.ts');
  const trustedSelector = run.detectorRoot !== '.';
  const result = spawnSync(process.execPath, [selector], {
    stdio: 'inherit',
    env: {
      ...process.env,
      // A selector outside the workspace reads the workspace's test plans and sources.
      ...(trustedSelector ? { IOS_AFFECTED_TESTS_WORKSPACE: resolve(process.cwd()) } : {}),
      GITHUB_OUTPUT: outputPath,
      IOS_AFFECTED_TESTS_CHANGED_FILES: run.changedFiles,
      IOS_AFFECTED_TESTS_CHANGED_FILES_EXPLICIT_EMPTY:
        String(run.changedFiles.trim() === ''),
      IOS_AFFECTED_TESTS_LANE: run.lane,
      IOS_AFFECTED_TESTS_MODE: 'affected',
      ...(run.storekitRequired === undefined
        ? {}
        : { IOS_AFFECTED_TESTS_STOREKIT_REQUIRED: run.storekitRequired }),
    },
  });
  if (result.error !== undefined) throw result.error;
  // `set -e` ended the step on a failing selector without printing anything of
  // its own; the selector has already reported on the inherited stderr.
  if (result.status !== 0) throw new StepFailure('', 'stdout', result.status ?? 1);
  return readFileSync(outputPath, 'utf8');
}

/**
 * A queue candidate's inventory is its diff against the queue base the precheck
 * proved, or `null` when GitHub already deleted the candidate (the gate then
 * hands the cancel to the trusted cancel-deleted-queue-candidate job).
 */
async function mergeGroupChangedFiles(environment: Environment): Promise<string | null> {
  const event = readMergeGroupEvent();
  if (event === undefined) throw new StepFailure('::error::merge_group detection ran outside a merge_group event.');
  if (environment.MERGE_GROUP_REF !== event.queueRef
    || environment.IOS_AFFECTED_TESTS_BASE !== event.trustedBaseSha
    || environment.IOS_AFFECTED_TESTS_HEAD !== event.headSha) {
    throw new StepFailure('::error::iOS change detection inputs do not match the merge_group payload tuple.');
  }
  try {
    const inventory = await readMergeGroupInventory({
      repository: event.repository, serverUrl: environment.GITHUB_SERVER_URL,
      baseSha: event.trustedBaseSha, candidateSha: event.headSha, queueRef: event.queueRef,
      token: environment.GITHUB_TOKEN, temporaryRoot: environment.RUNNER_TEMP,
    });
    return inventory.changed.join('\n');
  } catch (error) {
    if (!(error instanceof MergeQueueCandidateGone)) throw error;
    // Read-only: this job's token never writes. The gate's
    // merge_queue_candidate_gone output hands the cancel to a trusted job.
    const gone = await queueCandidateGone({
      apiUrl: environment.GITHUB_API_URL, repository: event.repository, queueRef: event.queueRef,
      request: createGithubRequester({ tokens: [environment.GITHUB_TOKEN] }),
    });
    if (!gone) throw error;
    console.log(`::notice::${error.message} The run is cancelled instead of failing.`);
    return null;
  }
}

async function resolveChangedFiles(environment: Environment): Promise<string | null> {
  if (environment.EVENT_NAME === 'merge_group') return mergeGroupChangedFiles(environment);
  if (environment.TEST_SCOPE === 'promotion-evidence') {
    return promotionChangedFiles({
      baseSha: environment.IOS_AFFECTED_TESTS_BASE,
      sourceSha: environment.IOS_AFFECTED_TESTS_HEAD,
      remote: `https://github.com/${environment.REPOSITORY}.git`,
      cwd: process.cwd(),
      env: githubGitEnvironment(environment.GITHUB_TOKEN),
    });
  }
  if (environment.CONTROLLER_BASE_UPDATE_VALID === 'true') {
    return environment.CONTROLLER_BASE_UPDATE_FILES;
  }
  return fetchPullRequestChangedFiles({
    prNumber: environment.PR_NUMBER,
    repository: environment.REPOSITORY,
    token: environment.GITHUB_TOKEN,
    fallbackToken: environment.GITHUB_FALLBACK_TOKEN,
  });
}

await runStep('Typed iOS change detection', async () => {
  const environment = environmentSchema.parse(process.env);
  const context: GateContext = {
    forcedIosLanesRaw: environment.FORCED_IOS_LANES,
    reuseNativeEvidenceRaw: environment.CONTROLLER_BASE_UPDATE_REUSE_NATIVE_EVIDENCE,
    changedFilesDelimiter:
      `CHANGED_FILES_${environment.GITHUB_RUN_ID}_${environment.GITHUB_RUN_ATTEMPT}`,
  };

  const early = detectEarlyExitOutputs(context, {
    eventName: environment.EVENT_NAME,
    testScope: environment.TEST_SCOPE,
    baseUpdateSuperseded: environment.CONTROLLER_BASE_UPDATE_SUPERSEDED,
    baseUpdateDeferred: environment.CONTROLLER_BASE_UPDATE_DEFERRED,
  });
  if (early !== undefined) {
    publish(early);
    return;
  }

  const changedFiles = await resolveChangedFiles(environment);
  if (changedFiles === null) {
    publish(candidateGoneOutputs(context));
    appendStepOutputs([{ key: 'candidate_gone', value: 'true' }]);
    return;
  }
  const plan = planIosChangeDetection(context, {
    eventName: environment.EVENT_NAME,
    baseRef: environment.GITHUB_BASE_REF,
    changedFiles,
    reuseNativeEvidence: environment.CONTROLLER_BASE_UPDATE_REUSE_NATIVE_EVIDENCE,
    forcedIosAuxiliaryRaw: environment.FORCED_IOS_AUXILIARY,
  });
  if (plan.kind === 'final') {
    publish(plan.outputs);
    return;
  }

  // Backend/docs-only changes end above. Only patch-level iOS selectors need
  // ancestry, so their bounded Git fetch cannot block unrelated pull requests.
  if (environment.EVENT_NAME === 'pull_request' || environment.EVENT_NAME === 'merge_group'
    || environment.TEST_SCOPE === 'promotion-evidence') {
    const mergeBase = ensureIosMergeBase({
      baseSha: environment.IOS_AFFECTED_TESTS_BASE,
      headSha: environment.IOS_AFFECTED_TESTS_HEAD,
      // A queue candidate and a promotion are immutable SHAs; only a PR is fetched by its head ref.
      prNumber: environment.EVENT_NAME === 'pull_request' && environment.TEST_SCOPE !== 'promotion-evidence'
        ? environment.PR_NUMBER : undefined,
      remote: `https://github.com/${environment.REPOSITORY}.git`,
      cwd: process.cwd(),
      env: githubGitEnvironment(environment.GITHUB_TOKEN),
    });
    console.log(`iOS selector ancestry proven at ${mergeBase}.`);
  }

  const nativeChangedFiles = nativeSelectorChangedFiles(changedFiles);
  const evidenceRequired = readSelectorDecision(
    lastSelectorValue(
      runAffectedTestSelector({
        detectorRoot: environment.IOS_CHANGE_DETECTOR_ROOT,
        lane: 'evidence',
        outputFile: 'ios-evidence-selection.txt',
        changedFiles: nativeChangedFiles,
      }),
      'should_run',
    ),
    selectorDecisionErrors.evidenceShouldRun,
  );

  const mainSelection = runAffectedTestSelector({
    detectorRoot: environment.IOS_CHANGE_DETECTOR_ROOT,
    lane: 'main',
    outputFile: 'ios-main-selection.txt',
    changedFiles: nativeChangedFiles,
    storekitRequired: String(plan.classification.storekitRequired),
  });
  const mainRequired = readSelectorDecision(
    lastSelectorValue(mainSelection, 'should_run'),
    selectorDecisionErrors.mainShouldRun,
  );
  const selectorOnboardingRequired = readSelectorDecision(
    lastSelectorValue(mainSelection, 'onboarding_required'),
    selectorDecisionErrors.mainOnboarding,
  );

  publish(completeIosChangeDetection(
    context,
    plan,
    { evidenceRequired, mainRequired, onboardingRequired: selectorOnboardingRequired },
    environment.CONTROLLER_BASE_UPDATE_REUSE_NATIVE_EVIDENCE,
  ));
});
