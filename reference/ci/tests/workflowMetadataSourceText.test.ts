import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { z } from 'zod';

import { selectPrInventorySource } from '../src/prChangeInventory.ts';
import { conventionalWorkflowText, workflowDocument, workflowJob } from '../src/workflowStepShell.ts';
import { normalizeSourceText, readSourceText, toCrlfSourceText } from '../../scripts/source-text.ts';

function readWorkflow(name: string): string {
  return conventionalWorkflowText(readSourceText(new URL(`../../.github/workflows/${name}`, import.meta.url)));
}
function jobSource(workflow: string, jobName: string): string {
  const marker = `\n  ${jobName}:\n`;
  const start = workflow.indexOf(marker);
  assert.notEqual(start, -1, `missing workflow job: ${jobName}`);
  const nextJobMatch = /^\s{2}[A-Za-z0-9_-]+:\s*$/gm;
  nextJobMatch.lastIndex = start + marker.length;
  const nextJob = nextJobMatch.exec(workflow)?.index ?? -1;
  return workflow.slice(start, nextJob === -1 ? undefined : nextJob);
}
const documentSchema = z.object({
  name: z.string().optional(),
  on: z.record(z.string(), z.unknown()),
  jobs: z.record(z.string(), z.object({
    if: z.string().optional(),
    steps: z.array(z.object({ name: z.string().optional(), if: z.string().optional() })
      .passthrough()).default([]),
  }).passthrough()),
}).passthrough();
function document(name: string): z.infer<typeof documentSchema> {
  return documentSchema.parse(workflowDocument(name));
}
function pullRequestTypes(name: string): string[] {
  return z.object({ types: z.array(z.string()) }).parse(document(name).on['pull_request']).types;
}

test('base edits use trusted continuity while native GitHub owns review state', () => {
  for (const file of ['pr-checks.yml', 'ios-tests.yml']) {
    assert.equal(pullRequestTypes(file).includes('edited'), false);
  }

  const reviewWorkflow = readWorkflow('cancel-blocked-pr-ci.yml');
  const reviewDocument = document('cancel-blocked-pr-ci.yml');
  for (const trigger of [
    'pull_request', 'pull_request_review',
    'pull_request_review_comment', 'issue_comment', 'status',
  ]) assert.equal(Object.hasOwn(reviewDocument.on, trigger), false, trigger);
  assert.equal(reviewDocument.jobs['cancel-blocked-pr-ci']?.if, undefined);
  assert.doesNotMatch(reviewWorkflow, /pr-terminal-cleanup-\$\{\{/);
  assert.equal(reviewDocument.concurrency, undefined);
  assert.doesNotMatch(reviewWorkflow, /queue: max/);

  const refreshDocument = document('refresh-pr-ci-after-base-edit.yml');
  assert.equal(refreshDocument.name, 'Refresh PR CI after base change');
  assert.ok(z.object({ types: z.array(z.string()) })
    .parse(refreshDocument.on['pull_request_target']).types.includes('edited'));
  assert.deepEqual(refreshDocument.on['workflow_run'], {
    workflows: ['Test - iOS'],
    types: ['completed'],
  });
  assert.equal(refreshDocument.jobs.refresh, undefined);
  assert.equal(refreshDocument.jobs['confirm-capture'], undefined);

  assert.match(
    String(refreshDocument.jobs['cancel-obsolete-ios']?.steps.find(
      step => step.name === 'Install typed planner dependencies',
    )?.if),
    /event\.action == 'edited' && github\.event\.changes\.base != null/,
  );
});

test('metadata edits cannot publish a new required lint context', () => {
  const lint = workflowJob('pr-checks.yml', 'lint');
  assert.equal(lint.name, 'Lint changed code');
  assert.equal(pullRequestTypes('pr-checks.yml').includes('edited'), false);
});

test('read-only PR metadata prefers the per-job Actions token with an App fallback', () => {
  for (const file of ['pr-checks.yml', 'ios-tests.yml']) {
    const workflow = readWorkflow(file);
    assert.match(workflow, /id: pr-metadata-token/);
    assert.doesNotMatch(workflow, /permission-actions:/);
    assert.match(workflow, /^ {2}pull-requests: read$/m);
    assert.match(workflow, /GITHUB_TOKEN: '?\$\{\{ github\.token \}\}'?/);
    assert.match(
      workflow,
      /GITHUB_FALLBACK_TOKEN: '?\$\{\{ steps\.pr-metadata-token\.outputs\.token \}\}'?/
    );
  }
});


test('workflow job and step parsing is unaffected by a CRLF checkout', () => {
  const workflow = readWorkflow('pr-checks.yml');
  const windowsWorkflow = normalizeSourceText(toCrlfSourceText(workflow));

  assert.equal(windowsWorkflow, workflow);

  const job = jobSource(windowsWorkflow, 'plan-pr-validation');
  assert.equal(job, jobSource(workflow, 'plan-pr-validation'));
  assert.match(job, /^ {4}runs-on: /m);

  for (const name of ['validate', 'server-tests']) {
    assert.ok(
      jobSource(windowsWorkflow, name).length > 0,
      `${name} job should still be locatable in a CRLF checkout`
    );
  }
});

test('readSourceText normalizes real CRLF files and strips a leading BOM', () => {
  const directory = mkdtempSync(path.join(tmpdir(), 'source-text-normalization-'));
  try {
    const crlfPath = path.join(directory, 'crlf.txt');
    const bomCrlfPath = path.join(directory, 'bom-crlf.txt');
    writeFileSync(crlfPath, 'alpha\r\nbeta\r\n');
    writeFileSync(bomCrlfPath, '\uFEFFalpha\r\nbeta\r\n');

    assert.equal(readSourceText(crlfPath), 'alpha\nbeta\n');
    assert.equal(readSourceText(bomCrlfPath), 'alpha\nbeta\n');
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('workflow parsing still rejects an absent job in either representation', () => {
  const workflow = readWorkflow('pr-checks.yml');

  for (const representation of [workflow, normalizeSourceText(toCrlfSourceText(workflow))]) {
    assert.throws(
      () => jobSource(representation, 'job-that-does-not-exist'),
      /missing workflow job: job-that-does-not-exist/
    );
  }
});

test('an empty classifier inventory without proven patch equivalence falls back to the PR inventory', () => {
  const decide = (valid: boolean, files: string, patchEquivalent: boolean) => selectPrInventorySource({
    superseded: false, valid, files, patchEquivalent,
  })?.source ?? 'fallback';
  assert.equal(decide(true, '', false), 'fallback');
  assert.equal(decide(true, '', true), 'classifier');
  assert.equal(decide(true, 'server/index.ts', false), 'classifier');
  assert.equal(decide(false, '', false), 'fallback');
});
