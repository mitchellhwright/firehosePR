import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { preserveDebtEvidence } from '../src/actions/debt/preserveDebtEvidence.ts';

test('artifact upload fallback retains only the first 240 lines of each evidence file', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'debt-evidence-summary-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const directory = join(root, 'debt-preflight-42-2');
  mkdirSync(directory);
  mkdirSync(join(directory, 'subdirectory'));
  writeFileSync(join(directory, 'b.json'), Array.from({ length: 250 }, (_, index) => `line ${index + 1}`).join('\n'));
  writeFileSync(join(directory, 'a.json'), '{"status":"passed"}\n');
  const summaryPath = join(root, 'summary.md');
  writeFileSync(summaryPath, 'existing summary\n');

  preserveDebtEvidence({ runnerTemp: root, runId: '42', runAttempt: '2', summaryPath });
  const summary = readFileSync(summaryPath, 'utf8');
  assert.match(summary, /^existing summary\n## Debt dependency evidence\n/m);
  assert.ok(summary.indexOf('### a.json') < summary.indexOf('### b.json'));
  assert.match(summary, /line 240\n```/);
  assert.doesNotMatch(summary, /line 241|subdirectory/);
});

test('artifact upload fallback still writes its explanation when no evidence directory exists', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'debt-evidence-summary-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const summaryPath = join(root, 'summary.md');
  preserveDebtEvidence({ runnerTemp: root, runId: '42', runAttempt: '2', summaryPath });
  assert.equal(readFileSync(summaryPath, 'utf8'),
    '## Debt dependency evidence\n\n'
    + 'Artifact storage rejected the upload; retaining the bounded evidence in this job summary.\n\n');
});
