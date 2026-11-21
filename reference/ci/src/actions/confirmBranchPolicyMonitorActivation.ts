import { appendFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  baselineActivationBlockers, branchPolicyBaseline, type BranchPolicyBaseline,
} from '../branchPolicy/baseline.ts';

/**
 * Runs before the privileged job and without any credential. The live
 * inspection may start only when every activation fact holds; otherwise
 * this step fails, so an inactive or half-activated monitor is a visible red
 * run rather than a skipped one that reads as green.
 */

/**
 * Decisions that must be recorded in #4085 and implemented in a reviewed
 * change before any live read may start. An entry is removed only by the
 * change that implements it.
 */
export const UNSETTLED_ACTIVATION_DECISIONS: readonly string[] = [
  '#4085 decision 7 (ruleset bypass visibility) is not decided and implemented; '
    + 'a read-only credential cannot see ruleset bypass actors, so every live read would fail',
];

export interface ActivationInput {
  readonly enabled: string | undefined;
  readonly ref: string | undefined;
  readonly defaultBranch: string | undefined;
  readonly baseline: BranchPolicyBaseline;
  readonly unsettledDecisions: readonly string[];
}

export function activationBlockers(input: ActivationInput): readonly string[] {
  const blockers: string[] = [];
  if (input.enabled !== 'true') {
    blockers.push('repository variable BRANCH_POLICY_MONITOR_ENABLED is not "true"; '
      + 'the #4085 operator enables it after provisioning read-only access');
  }
  if (!input.defaultBranch || input.ref !== `refs/heads/${input.defaultBranch}`) {
    blockers.push(`the monitor runs only from the default branch; this run is on ${input.ref ?? 'an unknown ref'}`);
  }
  blockers.push(...baselineActivationBlockers(input.baseline));
  for (const decision of input.unsettledDecisions) blockers.push(`unsettled activation decision — ${decision}`);
  return blockers;
}

export function main(): void {
  const blockers = activationBlockers({
    enabled: process.env['BRANCH_POLICY_MONITOR_ENABLED'],
    ref: process.env['GITHUB_REF'],
    defaultBranch: process.env['DEFAULT_BRANCH'],
    baseline: branchPolicyBaseline,
    unsettledDecisions: UNSETTLED_ACTIVATION_DECISIONS,
  });
  const heading = '## Branch policy monitor activation\n\n';
  const summary = blockers.length === 0
    ? `${heading}Active: the approved baseline and read-only inspection may run.\n`
    : `${heading}**Inactive.** Live inspection did not start:\n\n${blockers.map((blocker) => `- ${blocker}`).join('\n')}\n`;
  const summaryPath = process.env['GITHUB_STEP_SUMMARY'];
  if (summaryPath) appendFileSync(summaryPath, summary);
  process.stdout.write(summary);
  if (blockers.length > 0) {
    process.stdout.write('::error::Branch policy monitor is inactive; compliance was not inspected. '
      + 'See docs/security/branch-policy-monitor.md.\n');
    process.exitCode = 1;
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main();
