#!/usr/bin/env node

import { createHash } from 'node:crypto';
import { appendFileSync, existsSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import {
  renderDevelopmentCleanupAdvisory,
  summarizeDevelopmentCleanupEvidence,
} from '../../ios/onboardingLifecycleEvidence.ts';

interface EvidenceOptions {
  readonly events: string;
  readonly cleanup: string;
  readonly 'xcode-log': string;
  readonly xcresult: string;
  readonly sha: string;
  readonly output: string;
}

const proxyEventSchema = z.object({
  event: z.string(),
  sequence: z.number().int().positive(),
  commitSha: z.string(),
}).passthrough();
const armedEventSchema = proxyEventSchema.extend({
  event: z.literal('dashboard_fault_armed'),
  minimumAutomaticFailureCount: z.number().int().nonnegative(),
  minimumPreArmQuiescenceMilliseconds: z.number().int().nonnegative(),
  preArmQuiescentMilliseconds: z.number().int().nonnegative(),
  preArmActiveDashboardForwardCount: z.number().int().nonnegative(),
  preArmCompletedDashboardForwardCount: z.number().int().nonnegative(),
  preArmForwardedDashboardCount: z.number().int().nonnegative(),
});
const releasedEventSchema = proxyEventSchema.extend({
  event: z.literal('dashboard_fault_released'),
  forcedFailureCount: z.number().int().nonnegative(),
  minimumAutomaticFailureCount: z.number().int().nonnegative(),
});
const failureEventSchema = proxyEventSchema.extend({
  event: z.literal('dashboard_forced_unavailable'),
  method: z.string(),
  path: z.string(),
  statusCode: z.number().int(),
  forcedFailureCount: z.number().int().nonnegative(),
  minimumAutomaticFailureCount: z.number().int().nonnegative(),
});
const forwardEventSchema = proxyEventSchema.extend({
  event: z.literal('dashboard_forward_completed'),
  statusCode: z.number().int(),
  successfulDashboardForwardCount: z.number().int().nonnegative(),
});

/**
 * @typedef {{ events: string, cleanup: string, 'xcode-log': string, xcresult: string,
 *   sha: string, output: string }} EvidenceOptions
 */

function usage(): never {
  throw new Error(
    'Usage: validateOnboardingDashboardOfflineEvidence.ts '
      + '--events <jsonl> --cleanup <jsonl> --xcode-log <log> '
      + '--xcresult <bundle> --sha <commit> --output <json>',
  );
}

/**
 * @param {string[]} argv
 * @returns {EvidenceOptions}
 */
function parseArguments(argv: readonly string[]): EvidenceOptions {
  /** @type {Map<string, string>} */
  const values = new Map();
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index];
    const value = argv[index + 1];
    if (!key?.startsWith('--') || !value) usage();
    values.set(key.slice(2), value);
  }
  const required = (key: string): string => values.get(key) ?? usage();
  return {
    events: required('events'),
    cleanup: required('cleanup'),
    'xcode-log': required('xcode-log'),
    xcresult: required('xcresult'),
    sha: required('sha'),
    output: required('output'),
  };
}

/**
 * @param {string} filePath
 * @returns {unknown[]}
 */
function readJsonLines(filePath: string): unknown[] {
  const source = readFileSync(filePath, 'utf8').trim();
  if (!source) throw new Error(`Evidence file is empty: ${filePath}`);
  return source.split(/\r?\n/).map((line, index) => {
    try {
      return JSON.parse(line);
    } catch {
      throw new Error(`Invalid JSON on line ${index + 1}: ${filePath}`);
    }
  });
}

/**
 * @param {string} filePath
 * @returns {string}
 */
function sha256(filePath: string): string {
  return createHash('sha256').update(readFileSync(filePath)).digest('hex');
}

/**
 * @param {string} source
 * @param {string} marker
 * @param {number} expectedCount
 * @returns {number}
 */
function requireExactCount(source: string, marker: string, expectedCount: number): number {
  const count = source.split(marker).length - 1;
  if (count !== expectedCount) {
    throw new Error(`Expected ${marker} exactly ${expectedCount} time(s), found ${count}`);
  }
  return source.indexOf(marker);
}

function exactlyOne<T>(matches: readonly T[], message: string): T {
  const [match] = matches;
  if (match === undefined || matches.length !== 1) throw new Error(message);
  return match;
}

const options = parseArguments(process.argv.slice(2));
if (!/^[0-9a-f]{40}$/i.test(options.sha)) {
  throw new Error('--sha must be a full Git SHA');
}
if (!existsSync(path.join(options.xcresult, 'Info.plist'))) {
  throw new Error(`XCTest result bundle is missing Info.plist: ${options.xcresult}`);
}

const events = z.array(proxyEventSchema).parse(readJsonLines(options.events));
for (const [index, event] of events.entries()) {
  if (event.sequence !== index + 1) {
    throw new Error(`Proxy evidence sequence is not contiguous at event ${index + 1}`);
  }
  if (event.commitSha !== options.sha) {
    throw new Error(`Proxy evidence is not bound to exact head ${options.sha}`);
  }
}

const started = events.filter(event => event.event === 'proxy_started');
const armed = z.array(armedEventSchema).parse(
  events.filter(event => event.event === 'dashboard_fault_armed'),
);
const released = z.array(releasedEventSchema).parse(
  events.filter(event => event.event === 'dashboard_fault_released'),
);
const failures = z.array(failureEventSchema).parse(
  events.filter(event => event.event === 'dashboard_forced_unavailable'),
);
const forwards = z.array(forwardEventSchema).parse(
  events.filter(event => event.event === 'dashboard_forward_completed'),
);
const stopping = events.filter(event => event.event === 'proxy_stopping');
const stopped = events.filter(event => event.event === 'proxy_stopped');
const startAndArmMessage =
  'Proxy start and dashboard fault arm evidence must each appear exactly once';
exactlyOne(started, startAndArmMessage);
const armedEvent = exactlyOne(armed, startAndArmMessage);
const releasedEvent = exactlyOne(
  released,
  'Dashboard fault release evidence must appear exactly once',
);
const shutdownMessage =
  'Proxy shutdown evidence must contain exactly one stopping and stopped event';
const stoppingEvent = exactlyOne(stopping, shutdownMessage);
const stoppedEvent = exactlyOne(stopped, shutdownMessage);
if (events.some(event => ['proxy_error', 'proxy_stop_failed'].includes(event.event))) {
  throw new Error('Proxy evidence contains an execution or shutdown error');
}
if (armedEvent.minimumAutomaticFailureCount !== 4) {
  throw new Error('Dashboard fault evidence must require at least four automatic failures');
}
if (
  armedEvent.minimumPreArmQuiescenceMilliseconds !== 11_000
  || armedEvent.preArmQuiescentMilliseconds
    < armedEvent.minimumPreArmQuiescenceMilliseconds
  || armedEvent.preArmActiveDashboardForwardCount !== 0
  || armedEvent.preArmCompletedDashboardForwardCount
    !== armedEvent.preArmForwardedDashboardCount
) {
  throw new Error('Dashboard fault must be armed after verified pre-rebuild quiescence');
}
const [firstFailure] = failures;
const lastFailure = failures.at(-1);
if (
  firstFailure === undefined
  || lastFailure === undefined
  || failures.length < armedEvent.minimumAutomaticFailureCount
) {
  throw new Error(
    `Expected at least ${armedEvent.minimumAutomaticFailureCount} automatic-retry failures, `
      + `found ${failures.length}`,
  );
}
for (const [index, event] of failures.entries()) {
  if (
    event.forcedFailureCount !== index + 1
    || event.minimumAutomaticFailureCount !== armedEvent.minimumAutomaticFailureCount
    || event.method !== 'GET'
    || event.statusCode !== 503
    || event.path !== '/api/dashboard'
  ) {
    throw new Error(`Invalid forced dashboard failure evidence at index ${index}`);
  }
}
if (
  releasedEvent.forcedFailureCount !== failures.length
  || releasedEvent.minimumAutomaticFailureCount
    !== armedEvent.minimumAutomaticFailureCount
) {
  throw new Error('Dashboard fault release must account for every forced failure');
}
const initialSuccessfulForward = forwards.find(event =>
  event.statusCode >= 200
  && event.statusCode < 300
  && event.sequence < armedEvent.sequence
);
if (!initialSuccessfulForward) {
  throw new Error('A successful real-backend Dashboard load is required before the fault is armed');
}
const successfulForward = forwards.find(event =>
  event.statusCode >= 200
  && event.statusCode < 300
  && event.sequence > releasedEvent.sequence
);
if (!successfulForward) {
  throw new Error('A successful real-backend Dashboard retry is required');
}
if (!(armedEvent.sequence < firstFailure.sequence)) {
  throw new Error('Dashboard failure must be armed before the first Dashboard request');
}
if (!(lastFailure.sequence < releasedEvent.sequence
  && releasedEvent.sequence < successfulForward.sequence)) {
  throw new Error('The successful real-backend request must occur after explicit fault release');
}
if (!(successfulForward.sequence < stoppingEvent.sequence
  && stoppingEvent.sequence < stoppedEvent.sequence)) {
  throw new Error('Proxy must stop cleanly after the successful Dashboard retry');
}
if (events.some(event =>
  event.event === 'dashboard_forward_completed'
  && event.sequence > armedEvent.sequence
  && event.sequence < releasedEvent.sequence
)) {
  throw new Error('Dashboard reached the backend while the offline fault was armed');
}

const cleanupPresent = existsSync(options.cleanup);
const cleanupSummary = summarizeDevelopmentCleanupEvidence(
  cleanupPresent ? readFileSync(options.cleanup, 'utf8') : undefined,
  options.sha,
);
if (!cleanupSummary.complete) {
  process.stdout.write('::warning::Development synthetic-user cleanup evidence is incomplete; '
    + 'inspect the cleanup step and remove any retained development identities.\n');
}

const xcodeLog = readFileSync(options['xcode-log'], 'utf8');
const quiescentMarker = requireExactCount(xcodeLog, 'EXAMPLE_3924_DASHBOARD_PROXY_QUIESCENT', 1);
const armedMarker = requireExactCount(xcodeLog, 'EXAMPLE_3924_DASHBOARD_PROXY_ARMED', 1);
const retryVisibleMarker = requireExactCount(
  xcodeLog,
  'EXAMPLE_3924_DASHBOARD_OFFLINE_RETRY_VISIBLE',
  1,
);
const releasedMarker = requireExactCount(xcodeLog, 'EXAMPLE_3924_DASHBOARD_PROXY_RELEASED', 1);
const retrySucceededMarker = requireExactCount(xcodeLog, 'EXAMPLE_3924_DASHBOARD_RETRY_SUCCEEDED', 1);
if (!(quiescentMarker < armedMarker
  && armedMarker < retryVisibleMarker
  && retryVisibleMarker < releasedMarker
  && releasedMarker < retrySucceededMarker)) {
  throw new Error('Dashboard UI evidence markers are out of order');
}

const manifest = {
  schemaVersion: 1,
  commitSha: options.sha,
  dashboard: {
    initialSuccessStatus: initialSuccessfulForward.statusCode,
    preArmQuiescentMilliseconds: armedEvent.preArmQuiescentMilliseconds,
    preArmForwardedDashboardCount: armedEvent.preArmForwardedDashboardCount,
    minimumAutomaticFailureCount: armedEvent.minimumAutomaticFailureCount,
    automaticFailureCount: failures.length,
    successfulRetryStatus: successfulForward.statusCode,
    successfulDashboardForwardCount:
      successfulForward.successfulDashboardForwardCount,
    proxyStopped: true,
  },
  cleanup: {
    complete: cleanupSummary.complete,
    verifiedRoles: cleanupSummary.verifiedRoles,
  },
  files: {
    proxyEvents: {
      path: options.events,
      bytes: statSync(options.events).size,
      sha256: sha256(options.events),
    },
    cleanupEvents: cleanupPresent ? {
      path: options.cleanup,
      bytes: statSync(options.cleanup).size,
      sha256: sha256(options.cleanup),
    } : { path: options.cleanup, present: false },
    xcodebuildLog: {
      path: options['xcode-log'],
      bytes: statSync(options['xcode-log']).size,
      sha256: sha256(options['xcode-log']),
    },
    xcresultInfo: {
      path: path.join(options.xcresult, 'Info.plist'),
      sha256: sha256(path.join(options.xcresult, 'Info.plist')),
    },
  },
};

writeFileSync(options.output, `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 });
if (!cleanupSummary.complete && process.env.GITHUB_STEP_SUMMARY) {
  try {
    appendFileSync(process.env.GITHUB_STEP_SUMMARY, renderDevelopmentCleanupAdvisory({
      commitSha: options.sha,
      verifiedRoles: cleanupSummary.verifiedRoles,
      manifest,
    }));
  } catch (error) {
    process.stdout.write(`::warning::Could not retain cleanup advisory in job summary: ${String(error)}\n`);
  }
}
process.stdout.write(`${JSON.stringify(manifest)}\n`);
