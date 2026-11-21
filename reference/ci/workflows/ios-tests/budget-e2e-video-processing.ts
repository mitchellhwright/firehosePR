import {
  ciEventField, concat, expr, github, runner, typedJob, typedStep,
} from '../lib/index.ts';
import { budgetE2e } from './budget-e2e.ts';
import { iosChangeGate } from './ios-change-gate.ts';
import { CHECKOUT, setupNode, videoLane, videoProcessingRunner } from './shared.ts';

/**
 * Turn a failed Budget E2E recording into something a person can watch.
 *
 * A full-length simulator capture is too large to review and too large to
 * keep, so the compression happens off the Mac: the lane uploads the raw
 * recording and this job downloads it on trusted external Linux, compresses it
 * and republishes the result. Nothing merges on the answer — the job is
 * advisory, runs only for a failed deliberate dispatch against main, and carries
 * `continue-on-error` so a missing recording never colours the run.
 */

/** One run's own directory, so two attempts cannot process each other's frames. */
const RUN_ATTEMPT_SUFFIX = concat(github('run_id'), '-', github('run_attempt'));

const checkoutVideoTooling = typedStep({
  name: 'Checkout video tooling',
  doc: {
    purpose: 'Materialises the head revision the compression and upload programs in this job run from.',
    recovery: 'retry; a repeated failure is a GitHub or runner network problem',
  },
  owner: 'infrastructure',
  category: 'environment',
  unit: 'step',
  uses: CHECKOUT,
  with: {
    'fetch-depth': 1,
    filter: 'blob:none',
    'persist-credentials': false,
    ref: ciEventField('headSha'),
  },
});

const prepareVideoWorkspace = typedStep({
  name: 'Prepare isolated Budget video workspace',
  doc: {
    purpose: 'Owns a fresh run directory and publishes the raw and compressed Budget video paths.',
    recovery: 'the runner temp directory is unwritable; a repeated failure is a runner problem',
  },
  owner: 'automation',
  category: 'planning',
  unit: 'step',
  command: 'node ci/src/actions/ios/prepareBudgetVideoWorkspace.ts',
});

const downloadRawVideo = typedStep({
  name: 'Download raw Budget video',
  doc: {
    purpose: 'Fetches evidence from failed Budget shards in this exact run and attempt.',
    recovery: 'no failed shard uploaded a recording; read its upload step',
  },
  owner: 'automation',
  category: 'evidence',
  unit: 'step',
  uses: 'actions/download-artifact@v8.0.1',
  with: {
    pattern: concat('budget-e2e-evidence-', RUN_ATTEMPT_SUFFIX, '-*'),
    path: concat(runner('temp'), '/budget-video-', RUN_ATTEMPT_SUFFIX, '/raw'),
  },
});

const processVideo = typedStep({
  name: 'Process Budget video',
  doc: {
    purpose: 'Compresses the raw recording into the reviewable video the upload below publishes.',
    recovery: 'read the encoder log; a truncated recording is a problem in the lane that produced it',
  },
  owner: 'product',
  category: 'artifact',
  unit: 'step',
  command: 'node ci/src/actions/ios/processBudgetVideo.ts',
});

const uploadProcessedVideo = typedStep({
  name: 'Upload processed Budget video',
  doc: {
    purpose: 'Publishes the compressed Budget recording so a reviewer can watch the run back.',
    recovery: 'nothing was produced to upload; read the processing step above',
  },
  owner: 'automation',
  category: 'evidence',
  unit: 'step',
  if: expr('always()'),
  continueOnError: true,
  uses: 'actions/upload-artifact@v7.0.1',
  with: {
    name: concat('budget-e2e-video-', RUN_ATTEMPT_SUFFIX),
    path: expr('env.BUDGET_E2E_COMPRESSED_VIDEO'),
    'compression-level': 0,
    'if-no-files-found': 'warn',
    'retention-days': 14,
  },
});

export const budgetE2eVideoProcessing = typedJob('budget-e2e-video-processing', {
  name: 'Budget E2E video processing (non-gating)',
  doc: {
    purpose: 'Compresses a failed Budget E2E recording off the Mac for diagnosis.',
    successMeaning: 'A reviewable failed Budget E2E recording is attached to this run.',
  },
  owner: 'product',
  category: 'coordination',
  unit: 'suite',
  needs: [iosChangeGate, budgetE2e],
  if: expr(
    "always() && github.event_name == 'workflow_dispatch' && github.ref == 'refs/heads/main' "
    + "&& inputs.test_scope != 'debt-card-evidence' && needs.budget-e2e.result == 'failure'",
  ),
  runsOn: videoProcessingRunner,
  continueOnError: true,
  permissions: { actions: 'read', contents: 'read' },
  lane: videoLane,
  steps: [
    checkoutVideoTooling,
    setupNode('Setup Node for the typed video steps'),
    prepareVideoWorkspace,
    downloadRawVideo,
    processVideo,
    uploadProcessedVideo,
  ],
});
