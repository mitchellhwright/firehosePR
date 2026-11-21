/**
 * Decides whether one failed `xcodebuild test-without-building` session is the
 * transient SpringBoard launch denial the precompiled lanes retry once:
 * `Busy ("Application failed preflight checks")` while launching the
 * `.xctrunner`, before any test of this session ran.
 *
 * The rule stays narrow on purpose. A retry must never re-run a session in
 * which a test executed, so every signal has to agree: exit status 65, a
 * simulator destination addressed by UDID, the launch-denial markers in this
 * session's log, no test lifecycle line in that log, and an xcresult summary
 * that contains nothing but the synthetic failure Xcode records for a test
 * runner that never launched.
 */

export type BusyVerdict =
  | { readonly retryable: true }
  | { readonly retryable: false; readonly reason: string };

export interface BusySession {
  readonly status: number;
  readonly destination: string;
  /** This session's xcodebuild output only. */
  readonly log: string;
  /** `xcresulttool get test-results summary --format json`, parsed; undefined when unreadable. */
  readonly summary: unknown;
}

const runnerLaunchFailure = /failed to launch[^\p{Cc}]*\.xctrunner/iu;
const preflightDenial = 'Application failed preflight checks';
const busyReason = /BSErrorCodeDescription[= ]+Busy|reason: Busy/;
const testLifecycleLine = new RegExp([
  String.raw`Test (Case|Suite|case|suite) .* (started|passed|failed)`,
  String.raw`Executed [1-9][0-9]* tests?`,
  String.raw`[◇✔✘]\s+Test( run)? .* (started|passed|failed)`,
].join('|'), 'i');

/** Xcode names the synthetic failure `<Target>-Runner encountered an error`. */
const runnerErrorTestName = /-Runner encountered an error$/;
const runnerLaunchFailureText = 'Failed to install or launch the test runner';

/** True when the log shows SpringBoard denying the `.xctrunner` launch as Busy. */
export function hasBusyRunnerLaunchDenial(log: string): boolean {
  return runnerLaunchFailure.test(log) && log.includes(preflightDenial) && busyReason.test(log);
}

/** True when the log shows any test starting, passing or failing. */
export function logShowsTestExecution(log: string): boolean {
  return testLifecycleLine.test(log);
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isRunnerLaunchDenial(failure: unknown): boolean {
  if (!isRecord(failure)) return false;
  const { testName, failureText } = failure;
  return typeof testName === 'string' && runnerErrorTestName.test(testName)
    && typeof failureText === 'string' && failureText.includes(runnerLaunchFailureText)
    && failureText.includes(preflightDenial);
}

/**
 * Proof from the result bundle that no test ran. Xcode counts a runner that
 * never launched as one failed test named `<Target>-Runner encountered an
 * error`, so a summary is zero-execution when nothing passed, was skipped or
 * was an expected failure, and every counted failure is that synthetic one.
 */
export function summaryProvesNoTestRan(summary: unknown): boolean {
  if (!isRecord(summary)) return false;
  const count = (key: string): number | undefined => {
    const value = summary[key];
    return typeof value === 'number' && Number.isInteger(value) ? value : undefined;
  };
  const total = count('totalTestCount');
  const failed = count('failedTests');
  if (count('passedTests') !== 0 || count('skippedTests') !== 0 || count('expectedFailures') !== 0) {
    return false;
  }
  if (total === undefined || total !== failed) return false;
  if (total === 0) return true;
  const failures = summary['testFailures'];
  return Array.isArray(failures) && failures.length === failed && failures.every(isRunnerLaunchDenial);
}

function isSimulatorUdidDestination(destination: string): boolean {
  return destination.includes('platform=iOS Simulator') && /(^|,)id=[^,]+/.test(destination);
}

/**
 * The conditions that need only the exit status, destination and log, in order.
 * Undefined when they all hold, so the caller reads the xcresult summary only
 * for a session that already looks like the Busy launch denial.
 */
export function busyLogRefusal(session: Omit<BusySession, 'summary'>): BusyVerdict | undefined {
  if (session.status !== 65) {
    return { retryable: false, reason: `xcodebuild exited ${session.status}, not 65` };
  }
  if (!isSimulatorUdidDestination(session.destination)) {
    return { retryable: false, reason: `destination ${session.destination} is not a simulator UDID` };
  }
  if (!hasBusyRunnerLaunchDenial(session.log)) {
    return { retryable: false, reason: 'the log has no Busy .xctrunner launch denial' };
  }
  if (logShowsTestExecution(session.log)) {
    return { retryable: false, reason: 'the log shows a test started, passed or failed in this session' };
  }
  return undefined;
}

/** Every condition in order; the first that fails names why no retry happens. */
export function classifyBusySession(session: BusySession): BusyVerdict {
  const logRefusal = busyLogRefusal(session);
  if (logRefusal !== undefined) return logRefusal;
  if (!summaryProvesNoTestRan(session.summary)) {
    return {
      retryable: false,
      reason: 'the xcresult summary is unreadable or records a test other than the runner launch failure',
    };
  }
  return { retryable: true };
}
