#!/usr/bin/env node

import { createHash } from 'node:crypto';
import {
  mkdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import type { Stats } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { z } from 'zod';
import { isEvidenceAttachment, namedEvidenceAttachments } from '../../ios/evidenceAttachments.ts';

const lifecycleCases = [
  'null-phase',
  'day-0',
  'day-89',
  'day-90',
  'grace-day-1',
  'grace-day-30',
  'grace-expiry',
 ] as const;
const sizeCategories = ['large', 'accessibilityExtraExtraExtraLarge'] as const;
const screenshotSizeNames = ['normal', 'accessibility-xxxl'] as const;
const surfaces = ['journey', 'widget', 'sheet'] as const;
const expectedObservationKeys = new Set(
  lifecycleCases.flatMap(scenario => sizeCategories.map(sizeCategory => `${scenario}:${sizeCategory}`)),
);
const expectedStatusByScenario = new Map([
  ['null-phase', 'Unavailable'],
  ['day-0', 'In Progress'],
  ['day-89', 'In Progress'],
  ['day-90', 'Confirmed'],
  ['grace-day-1', 'Needs Attention'],
  ['grace-day-30', 'Needs Attention'],
  ['grace-expiry', 'Off Track'],
]);
const expectedBadgeValueByScenario = new Map([
  ['null-phase', 'Unavailable'],
  ['day-0', 'In progress'],
  ['day-89', 'In progress'],
  ['day-90', 'Confirmed'],
  ['grace-day-1', 'Needs attention'],
  ['grace-day-30', 'Needs attention'],
  ['grace-expiry', 'Off Track'],
]);
const screenshotNames = [
  ...lifecycleCases.flatMap(name => screenshotSizeNames.flatMap(size => (
    surfaces.map(surface => `issue-3932-${surface}-${name}-${size}`)
  ))),
];

type RequiredPathType = 'directory' | 'file';

interface ScreenshotEvidence {
  readonly name: string;
  readonly file: string;
  readonly sha256: string;
}

const frameSchema = z.object({
  x: z.number(), y: z.number(), width: z.number(), height: z.number(),
}).passthrough();
const geometryManifestSchema = z.object({
  observations: z.array(z.object({
    scenario: z.string(),
    sizeCategory: z.string(),
    ringCenterGlyph: z.string(),
    elements: z.array(z.object({
      kind: z.string(),
      level: z.number(),
      frame: frameSchema,
    }).passthrough()),
  }).passthrough()),
}).passthrough();
const accessibilityElementSchema = z.object({
  identifier: z.string(),
  order: z.number().int(),
  label: z.string().optional(),
  value: z.string().optional(),
}).passthrough();
const accessibilityManifestSchema = z.object({
  observations: z.array(z.object({
    scenario: z.string(),
    sizeCategory: z.string(),
    journeyElements: z.array(accessibilityElementSchema),
    badgeElement: z.object({
      label: z.string(),
      value: z.string(),
    }).passthrough(),
  }).passthrough()),
}).passthrough();
const renderedSurfaceManifestSchema = z.object({
  renderedSurfaces: z.array(z.object({
    scenario: z.string(),
    sizeCategory: z.string(),
    surface: z.string(),
    elements: z.array(z.object({
      identifier: z.string(),
      label: z.string().optional(),
      value: z.string().optional(),
    }).passthrough()),
  }).passthrough()),
}).passthrough();

function fail(message: string): never {
  process.stderr.write(`financial-independence evidence error: ${message}\n`);
  process.exit(1);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function requirePath(path: string, label: string, type: RequiredPathType): Stats {
  let stats: Stats;
  try {
    stats = statSync(path);
  } catch {
    fail(`${label} is missing: ${path}`);
  }
  if (type === 'file' && !stats.isFile()) fail(`${label} is not a file: ${path}`);
  if (type === 'directory' && !stats.isDirectory()) fail(`${label} is not a directory: ${path}`);
  return stats;
}

function sha256(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

function marker(log: string, name: string): string {
  const matches = [...log.matchAll(new RegExp(`^${name}=(.+)$`, 'gm'))];
  if (matches.length !== 1) fail(`expected exactly one ${name} marker; found ${matches.length}`);
  const value = matches[0]?.[1];
  if (value === undefined) fail(`${name} marker has no value`);
  return value.trim();
}

function readManifest(root: string): unknown[] {
  const path = join(root, 'manifest.json');
  requirePath(path, 'attachment manifest', 'file');
  const groups = JSON.parse(readFileSync(path, 'utf8'));
  if (!Array.isArray(groups)) fail('attachment manifest root must be an array');
  return groups.flatMap((group, index) => {
    if (!isRecord(group) || !Array.isArray(group.attachments)) fail(`attachment group ${index} has no attachment array`);
    return group.attachments;
  });
}

function attachmentFor(attachments: readonly unknown[], name: string, extension: string): string {
  const matches = namedEvidenceAttachments(attachments, candidate => (
    candidate.startsWith(name) && candidate.toLowerCase().endsWith(extension)
  ));
  if (matches.length !== 1) fail(`expected exactly one ${name}${extension} attachment; found ${matches.length}`);
  const [attachment] = matches;
  if (!isEvidenceAttachment(attachment)) fail(`${name}${extension} attachment metadata is invalid`);
  if (attachment.isAssociatedWithFailure !== false) fail(`${name} is associated with a failure`);
  const file = attachment.exportedFileName;
  if (typeof file !== 'string' || basename(file) !== file) fail(`${name} has an invalid exported filename`);
  return file;
}

const args = process.argv.slice(2);
if (args.length !== 5) {
  fail('usage: <xcresult> <xcodebuild.log> <attachments> <evidence.json> <exact-head-sha>');
}

const [resultBundleArg, logPathArg, attachmentsRootArg, outputPathArg, exactHeadSHA] = args;
if (
  resultBundleArg === undefined ||
  logPathArg === undefined ||
  attachmentsRootArg === undefined ||
  outputPathArg === undefined ||
  exactHeadSHA === undefined
) {
  fail('usage: <xcresult> <xcodebuild.log> <attachments> <evidence.json> <exact-head-sha>');
}
const resultBundle = resolve(resultBundleArg);
const logPath = resolve(logPathArg);
const attachmentsRoot = resolve(attachmentsRootArg);
const outputPath = resolve(outputPathArg);
if (!/^[0-9a-f]{40}$/i.test(exactHeadSHA)) fail(`invalid exact-head SHA: ${exactHeadSHA}`);
requirePath(resultBundle, 'xcresult bundle', 'directory');
requirePath(join(resultBundle, 'Info.plist'), 'xcresult Info.plist', 'file');
requirePath(logPath, 'xcodebuild log', 'file');
requirePath(attachmentsRoot, 'attachment directory', 'directory');

const log = readFileSync(logPath, 'utf8');
if (marker(log, 'FINANCIAL_INDEPENDENCE_EXACT_HEAD_SHA').toLowerCase() !== exactHeadSHA.toLowerCase()) {
  fail('xcodebuild log exact-head SHA does not match requested evidence SHA');
}
if (Number(marker(log, 'FINANCIAL_INDEPENDENCE_SCREENSHOT_COUNT')) !== screenshotNames.length) {
  fail(`XCTest did not report ${screenshotNames.length} unique screenshots`);
}
if (marker(log, 'FINANCIAL_INDEPENDENCE_GEOMETRY') !== 'badge56_terminal1_connector_center') {
  fail('XCTest geometry completion marker is invalid');
}
if (Number(marker(log, 'FINANCIAL_INDEPENDENCE_ACCESSIBILITY_OBSERVATION_COUNT')) !== expectedObservationKeys.size) {
  fail('XCTest accessibility-observation completion marker is invalid');
}
if (Number(marker(log, 'FINANCIAL_INDEPENDENCE_RENDERED_SURFACE_COUNT')) !== expectedObservationKeys.size * surfaces.length) {
  fail('XCTest rendered-surface completion marker is invalid');
}
if (marker(log, 'FINANCIAL_INDEPENDENCE_SYSTEM_CONTENT_SIZE_LARGE') !== 'large') {
  fail('standard evidence did not run at the Large system content size');
}
if (
  marker(log, 'FINANCIAL_INDEPENDENCE_SYSTEM_CONTENT_SIZE_ACCESSIBILITY_XXXL') !==
  'accessibility-extra-extra-extra-large'
) {
  fail('accessibility evidence did not run at the Accessibility XXXL system content size');
}
if (/XCTSkip|Test Case .* skipped/i.test(log)) fail('evidence test was skipped');

const attachments = readManifest(attachmentsRoot);
const screenshots: ScreenshotEvidence[] = screenshotNames.map(name => {
  const file = attachmentFor(attachments, name, '.png');
  const path = join(attachmentsRoot, file);
  const stats = requirePath(path, name, 'file');
  if (stats.size <= 4_096) fail(`${name} is blank or truncated`);
  return { name, file, sha256: sha256(path) };
});
const screenshotsByHash = new Map<string, ScreenshotEvidence[]>();
for (const entry of screenshots) {
  const group = screenshotsByHash.get(entry.sha256) ?? [];
  group.push(entry);
  screenshotsByHash.set(entry.sha256, group);
}
for (const duplicateGroup of screenshotsByHash.values()) {
  if (duplicateGroup.length === 1) continue;
  fail('unexpected screenshots have identical image content');
}

function readJSONAttachment<TSchema extends z.ZodType>(name: string, schema: TSchema): {
  readonly file: string;
  readonly path: string;
  readonly value: z.output<TSchema>;
} {
  const file = attachmentFor(attachments, name, '.json');
  const path = join(attachmentsRoot, file);
  requirePath(path, name, 'file');
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    fail(`${name} is not valid JSON`);
  }
  const result = schema.safeParse(parsed);
  if (!result.success) fail(`${name} does not match the evidence contract`);
  return { file, path, value: result.data };
}

const geometryAttachments = sizeCategories.map(sizeCategory => (
  readJSONAttachment(`financial-independence-geometry-${sizeCategory}`, geometryManifestSchema)
));
const geometry = {
  value: {
    observations: geometryAttachments.flatMap(attachment => attachment.value.observations ?? []),
  },
};
const geometryKeys = new Set<string>();
for (const observation of geometry.value.observations) {
  const key = `${observation?.scenario}:${observation?.sizeCategory}`;
  geometryKeys.add(key);
  if (!expectedObservationKeys.has(key) || !Array.isArray(observation?.elements)) {
    fail(`geometry manifest contains an invalid observation: ${key}`);
  }
  const badges = observation.elements.filter(element => element?.kind === 'badge');
  const terminalBadges = badges.filter(element => element?.level === 11);
  const ordinaryBadge = badges.find(element => element?.level === 10);
  const incomingConnector = observation.elements.find(element => (
    element?.kind === 'incomingConnector' && element?.level === 11
  ));
  const outgoingTerminal = observation.elements.find(element => (
    element?.kind === 'outgoingConnector' && element?.level === 11
  ));
  if (terminalBadges.length !== 1 || !ordinaryBadge || !incomingConnector || outgoingTerminal) {
    fail(`geometry manifest does not prove one terminating terminal for ${key}`);
  }
  const terminalBadge = terminalBadges[0];
  if (terminalBadge === undefined) {
    fail(`geometry manifest is missing the terminal badge for ${key}`);
  }
  const frameValues = [terminalBadge.frame, ordinaryBadge.frame, incomingConnector.frame]
    .flatMap(frame => [frame?.x, frame?.y, frame?.width, frame?.height]);
  if (!frameValues.every(Number.isFinite)) {
    fail(`geometry manifest contains non-numeric measured frames for ${key}`);
  }
  if (
    Math.abs(terminalBadge.frame.width - 56) > 0.5 ||
    Math.abs(terminalBadge.frame.height - 56) > 0.5 ||
    Math.abs(ordinaryBadge.frame.width - terminalBadge.frame.width) > 0.5 ||
    Math.abs(ordinaryBadge.frame.height - terminalBadge.frame.height) > 0.5
  ) {
    fail(`geometry manifest does not prove balanced badge scale for ${key}`);
  }
  const terminalCenterY = terminalBadge.frame.y + terminalBadge.frame.height / 2;
  const connectorEndY = incomingConnector.frame.y + incomingConnector.frame.height;
  if (Math.abs(terminalCenterY - connectorEndY) > 0.5) {
    fail(`geometry manifest does not prove connector termination for ${key}`);
  }
  const lastBadge = badges.toSorted((left, right) => (
    left.frame.y + left.frame.height / 2 - (right.frame.y + right.frame.height / 2)
  )).at(-1);
  if (lastBadge?.level !== 11 || observation.ringCenterGlyph !== 'FI') {
    fail(`geometry manifest does not prove the balanced terminal contract for ${key}`);
  }
}
if (
  geometry.value.observations.length !== expectedObservationKeys.size ||
  geometryKeys.size !== expectedObservationKeys.size ||
  ![...expectedObservationKeys].every(key => geometryKeys.has(key))
) {
  fail('geometry manifest does not cover the lifecycle and accessibility-size matrix');
}

const accessibilityAttachments = sizeCategories.map(sizeCategory => (
  readJSONAttachment(
    `financial-independence-accessibility-order-${sizeCategory}`,
    accessibilityManifestSchema,
  )
));
const accessibility = {
  value: {
    observations: accessibilityAttachments.flatMap(attachment => attachment.value.observations ?? []),
  },
};
const renderedSurfaceAttachments = sizeCategories.map(sizeCategory => (
  readJSONAttachment(
    `financial-independence-rendered-surfaces-${sizeCategory}`,
    renderedSurfaceManifestSchema,
  )
));
const renderedSurfaces = {
  value: {
    renderedSurfaces: renderedSurfaceAttachments.flatMap(
      attachment => attachment.value.renderedSurfaces ?? [],
    ),
  },
};
const accessibilityKeys = new Set<string>();
const expectedJourneyIdentifiers = [
  'wellness_level_row_10',
  'wellness_level_row_11',
  'wellness_level_step_11_0',
  'wellness_level_step_11_1',
];
for (const observation of accessibility.value.observations) {
  const key = `${observation?.scenario}:${observation?.sizeCategory}`;
  accessibilityKeys.add(key);
  if (!expectedObservationKeys.has(key) || !Array.isArray(observation?.journeyElements)) {
    fail(`accessibility evidence contains an invalid observation: ${key}`);
  }
  const identifiers = observation.journeyElements.map(element => element?.identifier);
  const order = observation.journeyElements.map(element => element?.order);
  if (
    identifiers.length !== expectedJourneyIdentifiers.length ||
    !identifiers.every((identifier, index) => identifier === expectedJourneyIdentifiers[index]) ||
    !order.every((value, index) => {
      const previous = order[index - 1];
      return Number.isInteger(value) && (index === 0 || (previous !== undefined && value > previous));
    })
  ) {
    fail(`hosted Journey accessibility order is invalid for ${key}`);
  }
  const terminalLabel = observation.journeyElements[1]?.label;
  const expectedStatus = expectedStatusByScenario.get(observation.scenario);
  if (
    typeof terminalLabel !== 'string' ||
    expectedStatus === undefined ||
    !terminalLabel.includes(expectedStatus)
  ) {
    fail(`hosted terminal accessibility status is invalid for ${key}`);
  }
  if (
    observation.badgeElement?.label !== 'Financial independence' ||
    observation.badgeElement?.value !== expectedBadgeValueByScenario.get(observation.scenario)
  ) {
    fail(`hosted badge accessibility output is invalid for ${key}`);
  }
  const renderedAccessibility = [
    ...observation.journeyElements.flatMap(element => [element?.label, element?.value]),
    observation.badgeElement?.label,
    observation.badgeElement?.value,
  ].filter(Boolean).join(' ');
  if (/level 11|achieved|you made it|work is optional|safe forever/i.test(renderedAccessibility)) {
    fail(`hosted accessibility output contains forbidden terminal copy for ${key}`);
  }
}
if (
  accessibility.value.observations.length !== expectedObservationKeys.size ||
  accessibilityKeys.size !== expectedObservationKeys.size ||
  ![...expectedObservationKeys].every(key => accessibilityKeys.has(key))
) {
  fail('accessibility evidence does not cover the lifecycle and accessibility-size matrix');
}

const expectedRenderedSurfaceKeys = new Set(
  lifecycleCases.flatMap(scenario => sizeCategories.flatMap(sizeCategory => (
    surfaces.map(surface => `${scenario}:${sizeCategory}:${surface}`)
  ))),
);
const renderedSurfaceKeys = new Set<string>();
for (const observation of renderedSurfaces.value.renderedSurfaces) {
  const key = `${observation?.scenario}:${observation?.sizeCategory}:${observation?.surface}`;
  renderedSurfaceKeys.add(key);
  if (!expectedRenderedSurfaceKeys.has(key) || !Array.isArray(observation?.elements) || observation.elements.length === 0) {
    fail(`rendered surface evidence contains an invalid observation: ${key}`);
  }
  const strings = observation.elements
    .flatMap(element => [element.label, element.value])
    .filter((value): value is string => value !== undefined);
  if (/level 11|achieved|you made it|work is optional|safe forever/i.test(strings.join(' '))) {
    fail(`rendered surface contains forbidden terminal copy for ${key}`);
  }
  const identifiers = new Set(observation.elements.map(element => element.identifier));
  if (observation.surface === 'journey') {
    if (
      !identifiers.has('financial_wellness_level_card_title') ||
      !identifiers.has('financial_wellness_status_chip') ||
      ![...identifiers].some(identifier => identifier.startsWith('wellness_progress_'))
    ) {
      fail(`rendered Journey evidence omits terminal visible content for ${key}`);
    }
  } else if (observation.surface === 'widget') {
    if (!identifiers.has('dashboard_wellness_milestone_title')) {
      fail(`rendered widget evidence omits milestone text for ${key}`);
    }
  } else {
    const hasAssumptionsHeading = identifiers.has('wellness_level_detail_assumptions_heading');
    const hasSocialSecurity = identifiers.has('wellness_level_detail_row_social_security_value');
    const hasProgress = [...identifiers].some(identifier => identifier.startsWith('wellness_progress_'));
    if (
      !identifiers.has('wellness_level_detail_header') ||
      !identifiers.has('financial_wellness_status_chip') ||
      !hasProgress
    ) {
      fail(`rendered sheet evidence omits terminal or fetched detail content for ${key}`);
    } else if (observation.scenario === 'null-phase' && (hasAssumptionsHeading || hasSocialSecurity)) {
      fail(`unavailable rendered sheet includes projection assumptions for ${key}`);
    } else if (observation.scenario !== 'null-phase' && (!hasAssumptionsHeading || !hasSocialSecurity)) {
      fail(`rendered sheet evidence omits projection assumptions for ${key}`);
    } else if ([...identifiers].some(identifier => identifier.startsWith('wellness_level_detail_row_target_retirement_age_'))) {
      fail(`rendered sheet evidence includes target retirement age for ${key}`);
    }
  }
}
if (
  renderedSurfaces.value.renderedSurfaces.length !== expectedRenderedSurfaceKeys.size ||
  renderedSurfaceKeys.size !== expectedRenderedSurfaceKeys.size ||
  ![...expectedRenderedSurfaceKeys].every(key => renderedSurfaceKeys.has(key))
) {
  fail('rendered surface evidence does not cover every lifecycle, size, and surface');
}

const evidence = {
  issue: 3932,
  exactHeadSHA,
  generatedAt: new Date().toISOString(),
  resultInfoPlistSHA256: sha256(join(resultBundle, 'Info.plist')),
  logSHA256: sha256(logPath),
  screenshots,
  geometry: geometry.value,
  accessibilityObservations: accessibility.value.observations,
  renderedSurfaces: renderedSurfaces.value.renderedSurfaces,
  attachmentHashes: {
    geometry: geometryAttachments.map(attachment => sha256(attachment.path)),
    accessibility: accessibilityAttachments.map(attachment => sha256(attachment.path)),
    renderedSurfaces: renderedSurfaceAttachments.map(attachment => sha256(attachment.path)),
  },
};
mkdirSync(dirname(outputPath), { recursive: true });
writeFileSync(outputPath, `${JSON.stringify(evidence, null, 2)}\n`);
process.stdout.write(`Financial independence evidence verified for ${exactHeadSHA}: ${screenshots.length} unique screenshots.\n`);
