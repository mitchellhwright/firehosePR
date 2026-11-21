import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import { load } from 'js-yaml';
import { z } from 'zod';

import {
  hostedLinuxRunnerLabels,
  sharedPortableLinuxRunnerLabels,
  trustedControlLinuxRunnerLabels,
} from '../src/runnerPolicy.ts';
import { evaluateExpression, type ExpressionValue } from './fixtures/actionsExpression.ts';

/**
 * Owner rule (2026-09-28): no job runs on GitHub-hosted Linux by default.
 * Hosted Linux is overflow, chosen only by a planner that read self-hosted
 * capacity (`selectPrLinuxRunners.ts`, `selectControlRunners.ts`), the bounded
 * first admission job that makes that capacity decision, or the isolation
 * route of a fork revision. Every generated job is evaluated for
 * each event its workflow subscribes to, as same-repository code with the
 * hosted lever on: without a planner output it must not resolve to hosted
 * Linux, and a planner-routed job resolves to hosted only when its planner
 * published hosted labels.
 */

const HOSTED = hostedLinuxRunnerLabels[0];
const REPOSITORY = 'example-org/example-app';
const INITIAL_ADMISSIONS = new Set(['pr-checks.yml:route-initial-control',
  'refresh-pr-ci-after-base-edit.yml:route-initial-control', 'ios-tests.yml:route-initial-control']);

/** Jobs that are hosted by design; each names what makes hosted the only correct host. */
const HOSTED_BY_DESIGN: Readonly<Record<string, string>> = {
  'hosted-linux-admission.yml:probe': 'it is the hosted-admission evidence the overflow planners read',
  'node-modules-cache.yml:populate': 'it saves the dependency cache only hosted overflow lanes restore',
  'branch-policy-monitor.yml:inspect': 'a manual, dispatch-only diagnostic kept off the control fleet',
};

/** Planner outputs that carry Linux runner labels. */
const LABEL_OUTPUT = /needs\.([a-z-]+)\.outputs\.([a-z_]*labels)/g;

const workflowSchema = z.object({
  on: z.record(z.string(), z.unknown()),
  jobs: z.record(z.string(), z.object({ 'runs-on': z.unknown() }).passthrough()),
});

function sameRepositoryContext(event: string): Record<string, ExpressionValue> {
  const pullRequest = {
    number: 7, draft: false, head: { sha: 'd'.repeat(40), repo: { full_name: REPOSITORY } }, base: { ref: 'develop' },
  };
  return {
    github: {
      event_name: event, repository: REPOSITORY, ref: 'refs/heads/develop',
      event: {
        pull_request: pullRequest,
        merge_group: { head_sha: 'c'.repeat(40), base_ref: 'refs/heads/develop' },
        repository: { full_name: REPOSITORY, default_branch: 'develop' },
      },
    },
    inputs: {}, matrix: {}, steps: {}, vars: { CI_HOSTED_LINUX_AVAILABLE: '1' },
  };
}

function plannerOutputs(runsOn: string, labels: readonly string[]): Record<string, ExpressionValue> {
  const needs: Record<string, { outputs: Record<string, string> }> = {};
  for (const [, job, output] of runsOn.matchAll(LABEL_OUTPUT)) {
    if (job === undefined || output === undefined) continue;
    needs[job] ??= { outputs: {} };
    const entry = needs[job];
    if (entry !== undefined) entry.outputs[output] = JSON.stringify(labels);
  }
  return needs;
}

function resolve(runsOn: unknown, scope: Record<string, ExpressionValue>): string {
  if (typeof runsOn !== 'string' || !runsOn.startsWith('${{')) return JSON.stringify(runsOn);
  try {
    return JSON.stringify(evaluateExpression(runsOn.slice('${{'.length, -'}}'.length), scope));
  } catch {
    // An expression that cannot resolve fails the job; it never places it on hosted Linux.
    return '"unresolved"';
  }
}

const workflows = readdirSync('.github/workflows').filter((file) => file.endsWith('.yml'));

describe('hosted Linux is overflow only', () => {
  for (const file of workflows) {
    const document = workflowSchema.parse(load(readFileSync(`.github/workflows/${file}`, 'utf8')));
    const events = Object.keys(document.on);
    for (const [id, job] of Object.entries(document.jobs)) {
      const key = `${file}:${id}`;
      if (HOSTED_BY_DESIGN[key] !== undefined) continue;
      const runsOn = job['runs-on'];
      if (INITIAL_ADMISSIONS.has(key)) {
        it('uses hosted Linux only while the admission policy is enabled', () => {
          assert.equal(job['timeout-minutes'], 5);
          for (const event of events) {
            const enabled = sameRepositoryContext(event);
            assert.ok(resolve(runsOn, enabled).includes(HOSTED), `${key} on ${event}`);
            const disabled = {
              ...enabled,
              vars: { CI_HOSTED_LINUX_AVAILABLE: '0' },
            };
            assert.deepEqual(
              JSON.parse(resolve(runsOn, disabled)),
              trustedControlLinuxRunnerLabels,
              `${key} on ${event} must fall back to trusted external control`,
            );
          }
        });
        continue;
      }
      it(`${key} never resolves to hosted Linux without a capacity decision`, () => {
        for (const event of events) {
          const scope = { ...sameRepositoryContext(event), needs: {} };
          assert.ok(!resolve(runsOn, scope).includes(HOSTED), `${key} on ${event}: ${resolve(runsOn, scope)}`);
        }
      });

      if (typeof runsOn !== 'string' || [...runsOn.matchAll(LABEL_OUTPUT)].length === 0) continue;
      it(`${key} is self-hosted while its planner saw capacity and hosted only when it chose overflow`, () => {
        for (const event of events.filter((name) => name === 'pull_request' || name === 'merge_group')) {
          for (const selfHosted of [trustedControlLinuxRunnerLabels, sharedPortableLinuxRunnerLabels]) {
            const scope: Record<string, ExpressionValue> = {
              ...sameRepositoryContext(event), needs: plannerOutputs(runsOn, selfHosted),
            };
            assert.ok(!resolve(runsOn, scope).includes(HOSTED), `${key} on ${event}`);
          }
          const overflow: Record<string, ExpressionValue> = {
            ...sameRepositoryContext(event), needs: plannerOutputs(runsOn, hostedLinuxRunnerLabels),
          };
          assert.ok(resolve(runsOn, overflow).includes(HOSTED), `${key} on ${event} ignores the planner's overflow`);
        }
      });
    }
  }

  it('lists only hosted-by-design jobs that still exist and are still hosted', () => {
    for (const [key, reason] of Object.entries(HOSTED_BY_DESIGN)) {
      const [file, id] = key.split(':');
      assert.ok(file !== undefined && id !== undefined && reason.length > 20);
      const document = workflowSchema.parse(load(readFileSync(`.github/workflows/${file}`, 'utf8')));
      assert.deepEqual(document.jobs[id]?.['runs-on'], [HOSTED], key);
    }
  });
});
