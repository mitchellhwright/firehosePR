import { type StepMessage, error, info } from './shared/stepDecision.ts';

/**
 * Stopping a proxy a real-server E2E lane started itself.
 *
 * Both lanes that run one — the dashboard-offline proxy and the Income Cloud
 * SQL proxy — recorded a PID and then, at teardown, had to answer the same
 * question: is the process still under that PID the one this job started? A
 * runner is shared, PIDs are recycled, and `kill` on a stranger would take
 * down another job, so the command line is read back and matched before any
 * signal is sent.
 *
 * The two differ in exactly two ways and this module holds both: whether a
 * process that is already gone is fine (the dashboard proxy exits on its own
 * when the lane finishes; the Cloud SQL proxy must still be running), and how
 * the refusal names what it refused.
 *
 * Pure: reading the command line, signalling and waiting for the log record
 * all happen in `ci/src/actions/ios/stopSupervisedProxy.ts`.
 */

export type ProxyAbsenceRule = 'already-stopped' | 'refuse';

export interface SupervisedProxySpec {
  readonly displayName: string;
  readonly pidVariable: string;
  readonly logVariable: string;
  /** Every marker must appear in the command line for the PID to be ours. */
  readonly markers: readonly string[];
  readonly whenAbsent: ProxyAbsenceRule;
  /** A refusal names the command line it read, or just the PID. */
  readonly refusalSubject: 'command-line' | 'pid';
  /** Regular expression the shared TypeScript log watcher blocks on after the signal. */
  readonly exitPattern: string;
  /** Printed once the exit record lands; the Cloud SQL proxy printed nothing. */
  readonly stoppedMessage?: string;
}

export type SupervisedProxyName = 'dashboard-offline' | 'income-cloud-sql';

export const supervisedProxies: Readonly<Record<SupervisedProxyName, SupervisedProxySpec>> = {
  'dashboard-offline': {
    displayName: 'Dashboard offline proxy',
    pidVariable: 'DASHBOARD_OFFLINE_PROXY_PID',
    logVariable: 'DASHBOARD_OFFLINE_PROXY_LOG',
    markers: ['ci/src/actions/ios/onboardingDashboardOfflineProxy.ts'],
    whenAbsent: 'already-stopped',
    refusalSubject: 'command-line',
    // The start step's wrapper appends an exit record to the proxy log when the
    // process ends; the stop blocks on that record rather than polling.
    exitPattern: '"exited":',
    stoppedMessage: 'Dashboard offline proxy stopped',
  },
  'income-cloud-sql': {
    displayName: 'Income E2E Cloud SQL proxy',
    pidVariable: 'INCOME_E2E_DB_PROXY_PID',
    logVariable: 'INCOME_E2E_DB_PROXY_LOG',
    markers: ['cloud-sql-proxy', 'example-dev-postgres'],
    whenAbsent: 'refuse',
    refusalSubject: 'pid',
    exitPattern: 'cloud-sql-proxy exited',
  },
};

export function isSupervisedProxyName(value: string): value is SupervisedProxyName {
  return Object.hasOwn(supervisedProxies, value);
}

export type ProxyStopPlan =
  | { readonly kind: 'skip'; readonly messages: readonly StepMessage[]; readonly exitCode: 0 }
  | { readonly kind: 'refuse'; readonly messages: readonly StepMessage[]; readonly exitCode: 1 }
  | {
    readonly kind: 'terminate';
    readonly pid: number;
    readonly exitPattern: string;
    /** Printed only after the exit record lands. */
    readonly messages: readonly StepMessage[];
    readonly exitCode: 0;
  };

export interface ProxyStopInput {
  readonly spec: SupervisedProxySpec;
  readonly pid: string;
  /** `ps -p PID -o command=`, empty when no such process exists. */
  readonly commandLine: string;
}

/**
 * Decides what to do with the recorded PID.
 *
 * A PID that is not a run of digits is refused rather than signalled: the
 * shell handed it straight to `kill`, where a negative number would have
 * signalled a whole process group.
 */
export function planProxyStop(input: ProxyStopInput): ProxyStopPlan {
  const { spec } = input;
  const commandLine = input.commandLine.trim();
  const refusal = (): ProxyStopPlan => ({
    kind: 'refuse',
    messages: [error(refusalMessage(spec, input.pid, commandLine))],
    exitCode: 1,
  });

  if (commandLine.length === 0) {
    if (spec.whenAbsent === 'refuse') return refusal();
    return { kind: 'skip', messages: [info(`${spec.displayName} already stopped`)], exitCode: 0 };
  }
  if (!spec.markers.every((marker) => commandLine.includes(marker))) return refusal();

  const digits = input.pid.trim();
  if (!/^\d+$/.test(digits)) return refusal();
  const pid = Number.parseInt(digits, 10);
  if (pid <= 0) return refusal();

  return {
    kind: 'terminate',
    pid,
    exitPattern: spec.exitPattern,
    messages: spec.stoppedMessage === undefined ? [] : [info(spec.stoppedMessage)],
    exitCode: 0,
  };
}

function refusalMessage(spec: SupervisedProxySpec, pid: string, commandLine: string): string {
  return spec.refusalSubject === 'command-line'
    ? `Refusing to stop an unrelated process: ${commandLine}`
    : `Refusing to stop an unowned process: ${pid}`;
}
