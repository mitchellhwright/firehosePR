import { actionsArtifactCleanup } from './actions-artifact-cleanup.ts';
import { branchPolicyMonitor } from './branch-policy-monitor.ts';
import { cancelBlockedPrCi } from './cancel-blocked-pr-ci.ts';
import { cancelDequeuedCandidate } from './cancel-dequeued-candidate.ts';
import { enableInternalPrAutoMerge } from './enable-internal-pr-auto-merge.ts';
import { hostedLinuxAdmission } from './hosted-linux-admission.ts';
import { installRunnerCleanupHooks } from './install-runner-cleanup-hooks.ts';
import { installRunnerCleanupHost } from './install-runner-cleanup-host.ts';
import { linuxRunnerHeartbeat } from './linux-runner-heartbeat.ts';
import { nativeTerminalIosCancel, nativeTerminalPrChecksCancel } from './native-terminal-pr-cancel.ts';
import { nodeModulesCache } from './node-modules-cache.ts';
import { productionDeployDispatch } from './production-deploy-dispatch.ts';
import { promotionCheckpoint } from './promotion-checkpoint.ts';
import { refreshPrCiAfterBaseEdit } from './refresh-pr-ci-after-base-edit.ts';
import { iosTests } from './ios-tests/index.ts';
import { prChecks } from './pr-checks.ts';
import { runnerActivationComplete } from './runner-activation-complete.ts';
import { trustedProductionOnboardingE2e } from './trusted-production-onboarding-e2e.ts';
import { vendoredLinkKitVersionCheck } from './vendored-linkkit-version-check.ts';
import { videoReviewWriter } from './video-review-writer.ts';
import { xcodeCloudBuildTags } from './xcode-cloud-build-tags.ts';
import type { WorkflowDefinition } from './lib/model.ts';

/**
 * Every workflow the generator owns, in emission order. A workflow is
 * migrated when its definition appears here: the drift check then proves the
 * committed YAML is the one this definition describes, and the projections
 * start covering its jobs and steps.
 */
export const definitions: readonly WorkflowDefinition[] = [
  actionsArtifactCleanup,
  branchPolicyMonitor,
  cancelBlockedPrCi,
  cancelDequeuedCandidate,
  enableInternalPrAutoMerge,
  hostedLinuxAdmission,
  installRunnerCleanupHooks,
  installRunnerCleanupHost,
  linuxRunnerHeartbeat,
  nativeTerminalIosCancel,
  nativeTerminalPrChecksCancel,
  nodeModulesCache,
  productionDeployDispatch,
  promotionCheckpoint,
  refreshPrCiAfterBaseEdit,
  iosTests,
  prChecks,
  runnerActivationComplete,
  trustedProductionOnboardingE2e,
  vendoredLinkKitVersionCheck,
  videoReviewWriter,
  xcodeCloudBuildTags,
];
