#!/usr/bin/env node

import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';

const surfaces = ['welcome', 'smart-cards', 'manual-account'] as const;
const contentSizes = [
  ['large', 'UICTContentSizeCategoryL'],
  ['ax-m', 'UICTContentSizeCategoryAccessibilityM'],
  ['ax-l', 'UICTContentSizeCategoryAccessibilityL'],
  ['ax-xl', 'UICTContentSizeCategoryAccessibilityXL'],
  ['ax-xxl', 'UICTContentSizeCategoryAccessibilityXXL'],
  ['ax-xxxl', 'UICTContentSizeCategoryAccessibilityXXXL'],
] as const;
const cells = surfaces.flatMap((surface) =>
  contentSizes.map(([slug, argument]) => ({ surface, slug, argument }))
);
const unflippedSmartCardsSizes = [
  ['large', 'UICTContentSizeCategoryL'],
  ['ax-xxxl', 'UICTContentSizeCategoryAccessibilityXXXL'],
] as const;

interface EvidenceCell {
  readonly surface: (typeof surfaces)[number];
  readonly slug: string;
  readonly argument: string;
}

interface Attachment {
  readonly suggestedHumanReadableName: string;
  readonly isAssociatedWithFailure: boolean;
  readonly exportedFileName: string;
}

interface AttachmentFile {
  readonly file: string;
  readonly path: string;
  readonly sha256: string;
}

function fail(message: string): never {
  process.stderr.write(`Issue #4549 evidence invalid: ${message}\n`);
  process.exit(1);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isAttachment(value: unknown): value is Attachment {
  return isRecord(value)
    && typeof value.suggestedHumanReadableName === 'string'
    && typeof value.isAssociatedWithFailure === 'boolean'
    && typeof value.exportedFileName === 'string';
}

function requireFile(path: string, label: string): void {
  if (!existsSync(path) || !statSync(path).isFile()) {
    fail(`${label} is missing at ${path}`);
  }
  if (statSync(path).size === 0) {
    fail(`${label} is empty at ${path}`);
  }
}

function readManifest(root: string): unknown[] {
  if (!existsSync(root) || !statSync(root).isDirectory()) {
    fail(`attachment directory is missing at ${root}`);
  }
  const manifestPath = join(root, 'manifest.json');
  requireFile(manifestPath, 'attachment manifest');
  let manifest;
  try {
    manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  } catch (error) {
    fail(`attachment manifest is not valid JSON: ${error instanceof Error ? error.message : error}`);
  }
  if (!Array.isArray(manifest)) {
    fail('attachment manifest must contain an array');
  }
  return manifest.flatMap((group, index) => {
    if (!isRecord(group) || !Array.isArray(group.attachments)) {
      fail(`attachment manifest group ${index} has no attachments array`);
    }
    return group.attachments;
  });
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function requireAttachment(
  root: string,
  attachments: readonly unknown[],
  name: string,
  extension: string,
): AttachmentFile {
  const pattern = new RegExp(
    `^\\d{4}-\\d{2}-\\d{2}-${escapeRegex(name)}` +
      `(?:_[0-9]+_[0-9a-f-]{36})?\\.${extension}$`,
    'i'
  );
  const matches = attachments.filter((attachment) =>
    isRecord(attachment) &&
    typeof attachment.suggestedHumanReadableName === 'string' &&
    pattern.test(attachment.suggestedHumanReadableName)
  );
  if (matches.length !== 1) {
    fail(`expected exactly one ${name}.${extension} attachment; found ${matches.length}`);
  }
  const [attachment] = matches;
  if (attachment === undefined) fail(`${name}.${extension} attachment is missing`);
  if (!isAttachment(attachment)) fail(`${name}.${extension} attachment has malformed fields`);
  if (attachment.isAssociatedWithFailure !== false) {
    fail(`${name}.${extension} is associated with a failure`);
  }
  if (
    typeof attachment.exportedFileName !== 'string' ||
    basename(attachment.exportedFileName) !== attachment.exportedFileName
  ) {
    fail(`${name}.${extension} has an invalid exported file name`);
  }
  const path = join(root, attachment.exportedFileName);
  requireFile(path, `${name}.${extension}`);
  return {
    file: attachment.exportedFileName,
    path,
    sha256: createHash('sha256').update(readFileSync(path)).digest('hex'),
  };
}

function parseMetadata(
  path: string,
  cell: EvidenceCell,
  exactHeadSha: string,
): Readonly<Record<string, string>> {
  const values: Record<string, string> = {};
  for (const line of readFileSync(path, 'utf8').split(/\r?\n/).filter(Boolean)) {
    const separator = line.indexOf('=');
    if (separator <= 0) {
      fail(`metadata for ${cell.surface}/${cell.slug} contains an invalid line`);
    }
    values[line.slice(0, separator)] = line.slice(separator + 1);
  }
  const expected = {
    exactHeadSHA: exactHeadSha,
    surface: cell.surface,
    contentSize: cell.argument,
    appearance: 'dark',
  };
  for (const [key, value] of Object.entries(expected)) {
    if (values[key] !== value) {
      fail(`metadata for ${cell.surface}/${cell.slug} has ${key}=${values[key] ?? '<missing>'}; expected ${value}`);
    }
  }
  for (const key of ['capturedAt', 'deviceName', 'deviceModel', 'runtime', 'viewport']) {
    if (!values[key] || values[key] === 'missing') {
      fail(`metadata for ${cell.surface}/${cell.slug} is missing ${key}`);
    }
  }
  const capturedAt = values.capturedAt;
  const deviceModel = values.deviceModel;
  const runtime = values.runtime;
  if (capturedAt === undefined || Number.isNaN(Date.parse(capturedAt))) {
    fail(`metadata for ${cell.surface}/${cell.slug} has an invalid capturedAt value`);
  }
  if (deviceModel === undefined || !deviceModel.startsWith('com.apple.CoreSimulator.SimDeviceType.')) {
    fail(`metadata for ${cell.surface}/${cell.slug} has an invalid simulator model`);
  }
  if (runtime === undefined || !runtime.startsWith('com.apple.CoreSimulator.SimRuntime.')) {
    fail(`metadata for ${cell.surface}/${cell.slug} has an invalid simulator runtime`);
  }
  return values;
}

const [attachmentRootArg, outputPathArg, exactHeadSha] = process.argv.slice(2);
if (!attachmentRootArg || !outputPathArg || !exactHeadSha) {
  fail('usage: <exported attachment directory> <evidence.json> <exact head sha>');
}
if (!/^[0-9a-f]{40}$/i.test(exactHeadSha)) {
  fail(`exact head SHA is invalid: ${exactHeadSha}`);
}

const attachmentRoot = resolve(attachmentRootArg);
const outputPath = resolve(outputPathArg);
const attachments = readManifest(attachmentRoot);
const issueAttachments = attachments.filter((attachment) =>
  isRecord(attachment) &&
  typeof attachment.suggestedHumanReadableName === 'string' &&
  attachment.suggestedHumanReadableName.includes('issue-4549-')
);
const copyScreenshotsPerSize = 5;
const expectedAttachmentCount = (cells.length * 3) + unflippedSmartCardsSizes.length
  + contentSizes.length * copyScreenshotsPerSize;
if (issueAttachments.length !== expectedAttachmentCount) {
  fail(`expected exactly ${expectedAttachmentCount} issue #4549 attachments; found ${issueAttachments.length}`);
}

const evidenceCells = cells.map((cell) => {
  const baseName = `issue-4549-${cell.surface}-${cell.slug}`;
  const screenshot = requireAttachment(
    attachmentRoot,
    issueAttachments,
    baseName,
    'png'
  );
  const tree = requireAttachment(
    attachmentRoot,
    issueAttachments,
    `${baseName}-accessibility-tree`,
    'txt'
  );
  const metadata = requireAttachment(
    attachmentRoot,
    issueAttachments,
    `${baseName}-metadata`,
    'txt'
  );
  const metadataValues = parseMetadata(metadata.path, cell, exactHeadSha);
  return {
    surface: cell.surface,
    contentSize: cell.argument,
    screenshot: { file: screenshot.file, sha256: screenshot.sha256 },
    accessibilityTree: { file: tree.file, sha256: tree.sha256 },
    metadata: { file: metadata.file, sha256: metadata.sha256 },
    device: {
      name: metadataValues.deviceName,
      model: metadataValues.deviceModel,
      runtime: metadataValues.runtime,
    },
  };
});

const unflippedSmartCards = unflippedSmartCardsSizes.map(([slug, argument]) => {
  const screenshot = requireAttachment(
    attachmentRoot,
    issueAttachments,
    `issue-4549-smart-cards-${slug}-front`,
    'png'
  );
  const matrixCell = evidenceCells.find(
    (cell) => cell.surface === 'smart-cards' && cell.contentSize === argument
  );
  if (!matrixCell) {
    fail(`unflipped Smart Cards ${slug} screenshot has no matching matrix provenance`);
  }
  return {
    contentSize: argument,
    screenshot: { file: screenshot.file, sha256: screenshot.sha256 },
    metadata: matrixCell.metadata,
    device: matrixCell.device,
  };
});

const smartCardCopy = contentSizes.flatMap(([slug, argument]) => {
  const matrixCell = evidenceCells.find(
    (cell) => cell.surface === 'smart-cards' && cell.contentSize === argument
  );
  if (!matrixCell) {
    fail(`Smart Cards ${slug} copy screenshot has no matching matrix provenance`);
  }
  return Array.from({ length: copyScreenshotsPerSize }, (_, index) => {
    const screenshot = requireAttachment(
      attachmentRoot, issueAttachments, `issue-4549-smart-cards-${slug}-copy-${index}`, 'png'
    );
    return {
      contentSize: argument,
      copyIndex: index,
      screenshot: { file: screenshot.file, sha256: screenshot.sha256 },
      metadata: matrixCell.metadata,
      device: matrixCell.device,
    };
  });
});

for (const [field, files] of [
  ['accessibilityTree', evidenceCells.map((cell) => cell.accessibilityTree.file)],
  ['metadata', evidenceCells.map((cell) => cell.metadata.file)],
] as const) {
  if (new Set(files).size !== cells.length) {
    fail(`${field} attachments are not unique across all 18 cells`);
  }
}
const screenshotFiles = [
  ...evidenceCells.map((cell) => cell.screenshot.file),
  ...unflippedSmartCards.map((capture) => capture.screenshot.file),
  ...smartCardCopy.map((capture) => capture.screenshot.file),
];
if (new Set(screenshotFiles).size !== screenshotFiles.length) {
  fail('screenshot attachments are not unique across the matrix and unflipped captures');
}

mkdirSync(dirname(outputPath), { recursive: true });
writeFileSync(
  outputPath,
  `${JSON.stringify({
    issue: 4549,
    exactHeadSha,
    counts: { screenshots: screenshotFiles.length, accessibilityTrees: 18, metadata: 18 },
    cells: evidenceCells,
    unflippedSmartCards,
    smartCardCopy,
  }, null, 2)}\n`
);
process.stdout.write(
  `Issue #4549 evidence verified at ${exactHeadSha}: ${screenshotFiles.length} screenshots, 18 accessibility trees, 18 metadata attachments.\n`
);
