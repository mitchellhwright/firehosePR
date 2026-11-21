import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { validatePreflight } from '../src/actions/debt/validateDebtProjectionTickets.ts';
import { runCiPreflight, selectedTickets } from '../src/actions/debt/runDebtProjectionPreflight.ts';

const catalog = {
  schemaVersion: 1,
  source: 'Synthetic dependency-policy fixture',
  tickets: [
    { id: 'SERVER-A', status: 'active', issue: 'https://github.com/fixture/repo/issues/1', prerequisites: [], externalContracts: [], requiredAcceptance: [] },
    { id: 'SERVER-B', status: 'active', issue: 'https://github.com/fixture/repo/issues/2', prerequisites: ['SERVER-A'], externalContracts: [], requiredAcceptance: [] },
  ],
};

function repository(): { root: string; base: string; head: string; git: (...args: string[]) => string } {
  const root = mkdtempSync(join(tmpdir(), 'debt-policy-ts-'));
  const git = (...args: string[]): string => execFileSync('git', args, {
    cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
  git('init', '--initial-branch=main');
  git('config', 'user.name', 'Policy Fixture');
  git('config', 'user.email', 'fixture@example.invalid');
  mkdirSync(join(root, 'server/docs/audits'), { recursive: true });
  writeFileSync(join(root, 'server/docs/audits/debt-projection-tickets.json'), JSON.stringify(catalog));
  git('add', '.');
  git('-c', 'commit.gpgsign=false', 'commit', '-m', 'fixture base');
  const base = git('rev-parse', 'HEAD');
  git('-c', 'commit.gpgsign=false', 'commit', '--allow-empty', '-m', 'fixture head');
  return { root, base, head: git('rev-parse', 'HEAD'), git };
}

test('dependency evidence requires exact ancestry and approved review', (t) => {
  const fixture = repository();
  t.after(() => rmSync(fixture.root, { recursive: true, force: true }));
  const foundation = { schemaVersion: 1, targetRevision: fixture.head, prerequisites: [], externalContracts: [] };
  assert.deepEqual(validatePreflight({ catalog, evidence: foundation, ticketId: 'SERVER-A', targetRef: 'HEAD', repo: fixture.root }).prerequisites, []);
  assert.throws(() => validatePreflight({ catalog, evidence: foundation, ticketId: 'SERVER-B', targetRef: 'HEAD', repo: fixture.root }), /Missing reviewed prerequisites/);
  const reviewed = {
    id: 'SERVER-A', status: 'implemented', implementationCommit: fixture.base, checkedCommit: fixture.base,
    review: { decision: 'approved', reviewer: 'Fixture Reviewer', reviewedAt: '2026-09-03T00:00:00Z', commit: fixture.base, url: 'https://example.invalid/review' },
    checks: [{ command: 'typed fixture', result: 'passed', evidenceUrl: 'https://example.invalid/check' }],
    acceptance: [{ criterion: 'Synthetic acceptance', evidenceUrl: 'https://example.invalid/acceptance' }],
  };
  const valid = { ...foundation, prerequisites: [reviewed] };
  assert.deepEqual(validatePreflight({ catalog, evidence: valid, ticketId: 'SERVER-B', targetRef: 'HEAD', repo: fixture.root }).prerequisites, ['SERVER-A']);
  assert.throws(() => validatePreflight({ catalog, evidence: { ...foundation, targetRevision: fixture.base }, ticketId: 'SERVER-A', targetRef: 'HEAD', repo: fixture.root }), /must equal checked revision/);
  assert.throws(() => validatePreflight({ catalog, evidence: { ...foundation, prerequisites: [{ ...reviewed, review: { ...reviewed.review, decision: 'pending' } }] }, ticketId: 'SERVER-B', targetRef: 'HEAD', repo: fixture.root }), /approved human review/);
});

test('PR preflight selects catalog issues and fails closed without their receipts', (t) => {
  const fixture = repository();
  t.after(() => rmSync(fixture.root, { recursive: true, force: true }));
  assert.deepEqual(selectedTickets({ catalog, body: 'Closes #2', repository: 'fixture/repo', changedPaths: [] }), ['SERVER-B']);
  assert.deepEqual(selectedTickets({ catalog, body: 'Closes #999', repository: 'fixture/repo', changedPaths: [] }), []);
  const event = {
    repository: { full_name: 'fixture/repo' },
    pull_request: { body: 'Closes #2', head: { sha: fixture.head }, base: { sha: fixture.base, ref: 'develop' } },
  };
  const outputDirectory = join(fixture.root, 'evidence');
  assert.throws(() => runCiPreflight({ event, repo: fixture.root, outputDirectory }), /Missing or invalid committed evidence template/);
  const summary: unknown = JSON.parse(readFileSync(join(outputDirectory, 'summary.json'), 'utf8'));
  assert.ok(summary !== null && typeof summary === 'object' && 'status' in summary);
  assert.equal(summary.status, 'failed');
});
