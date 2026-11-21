import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { maintainedRunnerHosts, type MaintainedRunnerHost } from '../maintainedRunnerHosts.ts';
import { requiredEnv } from '../ios/shared/actionIo.ts';
import { runCommand } from '../ios/shared/processRunner.ts';
import { info, pass, runAsyncStepProgram, type StepDecision } from '../ios/shared/stepDecision.ts';

export interface RawMaintenanceDispatchInputs {
  readonly repository: string;
  readonly ref: string;
  readonly hostLabel: string;
  readonly platform: string;
  readonly auditOnly: string;
  readonly runId: string;
  readonly runAttempt: string;
}

export type MaintenanceDispatchInputs = MaintainedRunnerHost & {
  readonly repository: string;
  readonly ref: 'develop' | 'main';
  readonly auditOnly: boolean;
  readonly runId: string;
  readonly runAttempt: string;
};

/** Validate the GitHub environment at the boundary before constructing a dispatch. */
export function parseMaintenanceDispatchInputs(raw: RawMaintenanceDispatchInputs): MaintenanceDispatchInputs {
  if (!/^[A-Za-z0-9][A-Za-z0-9-]*\/[A-Za-z0-9_.-]+$/.test(raw.repository)
    || ['.', '..'].includes(raw.repository.split('/')[1] ?? '')) {
    throw new Error('Runner maintenance requires an owner/repository identifier.');
  }
  if (raw.ref !== 'develop' && raw.ref !== 'main') {
    throw new Error('Runner maintenance requires a trusted develop or main ref.');
  }
  const host = maintainedRunnerHosts.find((candidate) => candidate.hostLabel === raw.hostLabel);
  if (host === undefined || host.platform !== raw.platform) {
    throw new Error('Runner maintenance requires a known host and its declared platform.');
  }
  if (raw.auditOnly !== 'true' && raw.auditOnly !== 'false') {
    throw new Error('Runner maintenance audit_only must be true or false.');
  }
  if (!/^[1-9][0-9]*$/.test(raw.runId) || !/^[1-9][0-9]*$/.test(raw.runAttempt)) {
    throw new Error('Runner maintenance requires positive GitHub run and attempt identifiers.');
  }
  return {
    ...host, repository: raw.repository, ref: raw.ref, auditOnly: raw.auditOnly === 'true',
    runId: raw.runId, runAttempt: raw.runAttempt,
  };
}

export function maintenanceDispatchRequest(inputs: MaintenanceDispatchInputs): {
  readonly path: string;
  readonly payload: {
    readonly ref: string;
    readonly inputs: {
      readonly host_label: string;
      readonly platform: string;
      readonly audit_only: string;
      readonly correlation_id: string;
    };
  };
} {
  const correlationId = `${inputs.runId}-${inputs.runAttempt}-${inputs.hostLabel}`;
  return {
    path: `/repos/${inputs.repository}/actions/workflows/install-runner-cleanup-host.yml/dispatches`,
    payload: {
      ref: inputs.ref,
      inputs: {
        host_label: inputs.hostLabel,
        platform: inputs.platform,
        audit_only: String(inputs.auditOnly),
        correlation_id: correlationId,
      },
    },
  };
}

async function postDispatch(path: string, payload: unknown): Promise<void> {
  const directory = await mkdtemp(join(requiredEnv('RUNNER_TEMP'), 'runner-maintenance-dispatch-'));
  try {
    const file = join(directory, 'request.json');
    await writeFile(file, JSON.stringify(payload), { mode: 0o600 });
    const result = await runCommand('gh', ['api', '--method', 'POST', path, '--input', file], {
      capture: true, timeoutMs: 30_000,
    });
    if (result.status !== 0) {
      throw new Error(`Could not dispatch isolated runner maintenance: ${result.stderr.trim()}`);
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

export async function dispatchRunnerMaintenance(
  inputs: MaintenanceDispatchInputs,
  post: (path: string, payload: unknown) => Promise<void> = postDispatch,
): Promise<StepDecision> {
  const request = maintenanceDispatchRequest(inputs);
  await post(request.path, request.payload);
  return pass(info(`Dispatched runner maintenance for ${inputs.hostLabel} as ${request.payload.inputs.correlation_id}.`));
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  await runAsyncStepProgram('Runner maintenance dispatch', async () => {
    requiredEnv('GH_TOKEN');
    return dispatchRunnerMaintenance(parseMaintenanceDispatchInputs({
      repository: requiredEnv('GITHUB_REPOSITORY'),
      ref: requiredEnv('GITHUB_REF_NAME'),
      hostLabel: requiredEnv('HOST_LABEL'),
      platform: requiredEnv('PLATFORM'),
      auditOnly: requiredEnv('AUDIT_ONLY'),
      runId: requiredEnv('GITHUB_RUN_ID'),
      runAttempt: requiredEnv('GITHUB_RUN_ATTEMPT'),
    }));
  });
}
