#!/usr/bin/env node

import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  validateCatalog,
  validatePreflight,
  type PreflightResult,
} from './validateDebtProjectionTickets.ts';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');
const catalogPath = 'server/docs/audits/debt-projection-tickets.json';
const evidenceDirectory = '.github/debt-projection-evidence/';
const shaPattern = /^[0-9a-f]{40}$/;

interface SelectedTicketOptions {
  readonly catalog: unknown;
  readonly body: unknown;
  readonly repository: unknown;
  readonly changedPaths: readonly string[];
}

interface PullRequestEvent {
  readonly repository?: { readonly full_name?: string };
  readonly pull_request: {
    readonly body: string | null;
    readonly head: { readonly sha: string };
    readonly base: { readonly sha: string; readonly ref: string };
  };
}

interface RunCiPreflightOptions {
  readonly event: unknown;
  readonly targetRef?: string;
  readonly outputDirectory: string;
  readonly repo?: string;
  readonly releaseBranch?: string;
}

interface PreflightSummary {
  readonly targetRevision: string;
  readonly headRevision: string;
  readonly baseRevision: string;
  readonly tickets: string[];
  status: 'running' | 'passed' | 'not-applicable' | 'release-promotion' | 'failed';
  readonly results: PreflightResult[];
  error?: string;
}

function requireCondition(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function pullRequestEvent(value: unknown): PullRequestEvent {
  requireCondition(isRecord(value) && isRecord(value.pull_request), 'Debt preflight requires pull_request event metadata');
  const pullRequest = value.pull_request;
  requireCondition(isRecord(pullRequest.head) && isRecord(pullRequest.base), 'PR head/base must be objects');
  const headSha = pullRequest.head.sha;
  const baseSha = pullRequest.base.sha;
  const baseRef = pullRequest.base.ref;
  const body = pullRequest.body;
  requireCondition(typeof headSha === 'string' && typeof baseSha === 'string', 'PR head/base must contain commit SHAs');
  requireCondition(typeof baseRef === 'string', 'PR base must contain a ref');
  requireCondition(body === null || typeof body === 'string', 'PR body must be text or null');
  const repository = isRecord(value.repository) && typeof value.repository.full_name === 'string'
    ? { full_name: value.repository.full_name }
    : undefined;
  return {
    ...(repository === undefined ? {} : { repository }),
    pull_request: {
      body,
      head: { sha: headSha },
      base: { sha: baseSha, ref: baseRef },
    },
  };
}

function git(repo: string, args: readonly string[]): string {
  return execFileSync('git', args, {
    cwd: repo, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

export function selectedTickets({
  catalog,
  body,
  repository,
  changedPaths,
}: SelectedTicketOptions): string[] {
  const tickets = validateCatalog(catalog);
  requireCondition(body === null || typeof body === 'string', 'PR body must be text or null');
  requireCondition(typeof repository === 'string' && /^[\w.-]+\/[\w.-]+$/.test(repository), 'Invalid PR repository');
  const selected = new Set<string>();
  const byIssue = new Map([...tickets.values()]
    .filter((ticket) => ticket.status === 'active')
    .map((ticket) => [ticket.issue.toLowerCase(), ticket.id]));
  const closingReference = /\b(?:close[sd]?|fix(?:es|ed)?|resolve[sd]?)\s+(?:https:\/\/github\.com\/([\w.-]+\/[\w.-]+)\/issues\/|([\w.-]+\/[\w.-]+)?#)(\d+)\b/gi;
  for (const match of (body ?? '').matchAll(closingReference)) {
    const owner = match[1] ?? match[2] ?? repository;
    const id = byIssue.get(`https://github.com/${owner}/issues/${match[3]}`.toLowerCase());
    if (id) selected.add(id);
  }
  for (const path of changedPaths) {
    if (!path.startsWith(evidenceDirectory) || path === `${evidenceDirectory}README.md`) continue;
    requireCondition(/^SERVER-[A-Z0-9-]+\.json$/.test(path.slice(evidenceDirectory.length)), `Unrecognized evidence path ${path}`);
    const id = path.slice(evidenceDirectory.length, -'.json'.length);
    requireCondition(tickets.has(id), `Unknown evidence ticket ${id}`);
    selected.add(id);
  }
  return [...selected].sort();
}

export function runCiPreflight({
  event, targetRef = 'HEAD', outputDirectory, repo = root, releaseBranch = 'main',
}: RunCiPreflightOptions): PreflightSummary {
  const metadata = pullRequestEvent(event);
  const { head, base, body } = metadata.pull_request;
  requireCondition(shaPattern.test(head?.sha ?? '') && shaPattern.test(base?.sha ?? ''), 'PR head/base must be full commit SHAs');
  const targetRevision = git(repo, ['rev-parse', '--verify', '--end-of-options', `${targetRef}^{commit}`]);
  for (const [name, sha] of [['head', head.sha], ['base', base.sha]] as const) {
    try { git(repo, ['merge-base', '--is-ancestor', sha, targetRevision]); }
    catch { throw new Error(`PR ${name} ${sha} is not an ancestor of checked revision ${targetRevision}; fetch full history and check out the current PR merge`); }
  }
  // Dependency review gates evidence on its way into the integration branch. A
  // release promotion diffs against the release branch, so it re-selects every
  // ticket accumulated since the last promotion and re-litigates reviews that
  // already passed. Those tickets are unchanged here, so skip rather than
  // block the release train on them.
  if (base.ref === releaseBranch) {
    mkdirSync(outputDirectory, { recursive: true });
    const promotion: PreflightSummary = {
      targetRevision, headRevision: head.sha, baseRevision: base.sha, tickets: [],
      status: 'release-promotion', results: [],
    };
    writeFileSync(resolve(outputDirectory, 'summary.json'), `${JSON.stringify(promotion, null, 2)}\n`);
    return promotion;
  }
  const catalog: unknown = JSON.parse(git(repo, ['show', `${targetRevision}:${catalogPath}`]));
  const changedPaths = git(repo, ['diff', '--name-only', `${base.sha}...${head.sha}`, '--', evidenceDirectory]).split('\n');
  const tickets = selectedTickets({ catalog, body, repository: metadata.repository?.full_name, changedPaths });
  mkdirSync(outputDirectory, { recursive: true });
  const summary: PreflightSummary = {
    targetRevision,
    headRevision: head.sha,
    baseRevision: base.sha,
    tickets,
    status: 'running',
    results: [],
  };
  try {
    for (const ticketId of tickets) {
      const sourcePath = `${evidenceDirectory}${ticketId}.json`;
      let template: unknown;
      try { template = JSON.parse(git(repo, ['show', `${targetRevision}:${sourcePath}`])); }
      catch { throw new Error(`Missing or invalid committed evidence template ${sourcePath}`); }
      requireCondition(isRecord(template), `${sourcePath} must be an object`);
      for (const field of Object.keys(template)) {
        requireCondition(['schemaVersion', 'prerequisites', 'externalContracts'].includes(field), `${sourcePath} has unknown field ${field}; CI binds targetRevision at runtime`);
      }
      // Only the target binding is created here. Reviewed prerequisite records
      // must be supplied verbatim; this never manufactures or updates approvals.
      const evidence = { ...template, targetRevision };
      writeFileSync(resolve(outputDirectory, `${ticketId}.json`), `${JSON.stringify(evidence, null, 2)}\n`);
      const result = validatePreflight({ catalog, evidence, ticketId, targetRef: targetRevision, repo });
      summary.results.push(result);
    }
    summary.status = tickets.length ? 'passed' : 'not-applicable';
    return summary;
  } catch (error) {
    summary.status = 'failed';
    summary.error = error instanceof Error ? error.message : 'Invalid evidence';
    throw error;
  } finally {
    writeFileSync(resolve(outputDirectory, 'summary.json'), `${JSON.stringify(summary, null, 2)}\n`);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const args = process.argv.slice(2);
    requireCondition(args.length === 4 && args[0] === '--event-path' && args[2] === '--output-dir', 'Usage: node ci/src/actions/debt/runDebtProjectionPreflight.ts --event-path <event.json> --output-dir <directory>');
    const eventPath = args[1];
    const outputDirectory = args[3];
    requireCondition(eventPath && outputDirectory, 'Debt preflight paths are missing');
    const result = runCiPreflight({
      event: JSON.parse(readFileSync(eventPath, 'utf8')),
      outputDirectory: resolve(outputDirectory),
    });
    process.stdout.write(`${JSON.stringify(result, null, 2)}\nDependency evidence structure and ancestry only; human review authenticity and implementation acceptance remain reviewer responsibilities.\n`);
  } catch (error) {
    process.stderr.write(`FAIL debt CI preflight: ${error instanceof Error ? error.message : 'Invalid input'}\n`);
    process.exitCode = 1;
  }
}
