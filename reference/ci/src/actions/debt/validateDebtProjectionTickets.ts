#!/usr/bin/env node

import { execFileSync, spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');
const catalogPath = 'server/docs/audits/debt-projection-tickets.json';
const shaPattern = /^[0-9a-f]{40}$/;

type TicketStatus = 'active' | 'deferred' | 'superseded';

export interface CatalogTicket {
  readonly id: string;
  readonly status: TicketStatus;
  readonly issue: string;
  readonly prerequisites: readonly string[];
  readonly externalContracts: readonly string[];
  readonly requiredAcceptance: readonly string[];
  readonly supersededBy?: string;
}

interface ReviewedCheck {
  readonly command: string;
  readonly result: 'passed';
  readonly evidenceUrl: string;
}

interface AcceptanceRecord {
  readonly criterion: string;
  readonly evidenceUrl: string;
}

interface ReviewedRecord {
  readonly id: string;
  readonly status: string;
  readonly implementationCommit: string;
  readonly checkedCommit: string;
  readonly review: {
    readonly decision: 'approved';
    readonly reviewer: string;
    readonly reviewedAt: string;
    readonly commit: string;
    readonly url: string;
  };
  readonly checks: readonly ReviewedCheck[];
  readonly acceptance: readonly AcceptanceRecord[];
}

export interface PreflightResult {
  readonly ticket: string;
  readonly targetRevision: string;
  readonly prerequisites: readonly string[];
  readonly externalContracts: readonly string[];
}

interface ValidatePreflightOptions {
  readonly catalog: unknown;
  readonly evidence: unknown;
  readonly ticketId: string;
  readonly targetRef: string;
  readonly repo?: string;
}

function requireCondition(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function object(
  value: unknown,
  fields: readonly string[],
  label: string,
): asserts value is Record<string, unknown> {
  requireCondition(value !== null && typeof value === 'object' && !Array.isArray(value), `${label} must be an object`);
  for (const field of Object.keys(value)) {
    requireCondition(fields.includes(field), `${label} has unknown field ${field}`);
  }
}

function nonempty(value: unknown, label: string): asserts value is string {
  requireCondition(typeof value === 'string' && value.trim().length > 0, `${label} must be nonempty text`);
}

function strings(value: unknown, label: string): asserts value is string[] {
  requireCondition(Array.isArray(value), `${label} must be an array`);
  value.forEach((item) => nonempty(item, label));
  requireCondition(new Set(value).size === value.length, `${label} contains duplicates`);
}

function httpsUrl(value: unknown, label: string): asserts value is string {
  nonempty(value, label);
  let url: URL;
  try { url = new URL(value); } catch { throw new Error(`${label} must be an HTTPS URL`); }
  requireCondition(url.protocol === 'https:' && !url.username && !url.password, `${label} must be an HTTPS URL without credentials`);
}

function commit(repo: string, ref: unknown): string {
  nonempty(ref, 'Git revision');
  try {
    return execFileSync('git', ['rev-parse', '--verify', '--end-of-options', `${ref}^{commit}`], {
      cwd: repo, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
    }).trim();
  } catch {
    throw new Error(`Cannot resolve commit ${ref}; fetch the required history before running the preflight`);
  }
}

function ancestor(repo: string, from: string, to: string, label: string): void {
  requireCondition(shaPattern.test(from), `${label} must be a full lowercase commit SHA`);
  requireCondition(commit(repo, from) === from, `${label} must identify a commit`);
  const result = spawnSync('git', ['merge-base', '--is-ancestor', from, to], { cwd: repo });
  requireCondition(result.status === 0, `${label} ${from} is not an ancestor of ${to}`);
}

export function validateCatalog(catalog: unknown): Map<string, CatalogTicket> {
  object(catalog, ['schemaVersion', 'source', 'tickets'], 'Catalog');
  requireCondition(catalog.schemaVersion === 1, 'Unsupported catalog schemaVersion');
  nonempty(catalog.source, 'Catalog source');
  requireCondition(Array.isArray(catalog.tickets) && catalog.tickets.length > 0, 'Catalog tickets must be a nonempty array');
  const tickets = new Map<string, CatalogTicket>();
  for (const entry of catalog.tickets) {
    object(entry, ['id', 'status', 'issue', 'prerequisites', 'externalContracts', 'requiredAcceptance', 'supersededBy'], 'Catalog ticket');
    requireCondition(typeof entry.id === 'string' && /^SERVER-[A-Z0-9-]+$/.test(entry.id), 'Invalid catalog ticket ID');
    requireCondition(!tickets.has(entry.id), `Duplicate catalog ID ${entry.id}`);
    requireCondition(entry.status === 'active' || entry.status === 'deferred' || entry.status === 'superseded', `Invalid status for ${entry.id}`);
    httpsUrl(entry.issue, `${entry.id} issue`);
    strings(entry.prerequisites, `${entry.id} prerequisites`);
    strings(entry.externalContracts, `${entry.id} externalContracts`);
    strings(entry.requiredAcceptance, `${entry.id} requiredAcceptance`);
    if (entry.status === 'superseded') nonempty(entry.supersededBy, `${entry.id} supersededBy`);
    else requireCondition(entry.supersededBy === undefined, `${entry.id} cannot declare supersededBy`);
    tickets.set(entry.id, {
      id: entry.id,
      status: entry.status,
      issue: entry.issue,
      prerequisites: entry.prerequisites,
      externalContracts: entry.externalContracts,
      requiredAcceptance: entry.requiredAcceptance,
      ...(entry.supersededBy === undefined ? {} : { supersededBy: entry.supersededBy }),
    });
  }
  for (const entry of tickets.values()) {
    for (const id of entry.prerequisites) requireCondition(tickets.has(id), `${entry.id} has unknown prerequisite ${id}`);
    if (entry.supersededBy) {
      requireCondition(tickets.get(entry.supersededBy)?.status === 'active', `${entry.id} must redirect to an active ticket`);
    }
  }
  const visited = new Set<string>();
  function visit(id: string, path: readonly string[]): void {
    requireCondition(!path.includes(id), `Dependency cycle: ${[...path, id].join(' -> ')}`);
    if (visited.has(id)) return;
    const ticket = tickets.get(id);
    requireCondition(ticket, `Unknown ticket ID ${id}`);
    ticket.prerequisites.forEach((dependency) => visit(dependency, [...path, id]));
    visited.add(id);
  }
  tickets.forEach((entry) => visit(entry.id, []));
  return tickets;
}

function active(tickets: ReadonlyMap<string, CatalogTicket>, id: string): CatalogTicket {
  const ticket = tickets.get(id);
  requireCondition(ticket, `Unknown ticket ID ${id}`);
  requireCondition(ticket.status === 'active', `${id} is ${ticket.status}${ticket.supersededBy ? `; use ${ticket.supersededBy}` : ''}`);
  return ticket;
}

function reviewedRecord(
  record: unknown,
  expectedStatus: string,
  repo: string,
  targetRevision: string,
): asserts record is ReviewedRecord {
  object(record, ['id', 'status', 'implementationCommit', 'checkedCommit', 'review', 'checks', 'acceptance'], 'Evidence record');
  nonempty(record.id, 'Evidence record ID');
  const label = record.id;
  requireCondition(record.status === expectedStatus, `${label} must have status ${expectedStatus}`);
  nonempty(record.implementationCommit, `${label} implementationCommit`);
  nonempty(record.checkedCommit, `${label} checkedCommit`);
  ancestor(repo, record.implementationCommit, targetRevision, `${label} implementationCommit`);
  ancestor(repo, record.checkedCommit, targetRevision, `${label} checkedCommit`);
  ancestor(repo, record.implementationCommit, record.checkedCommit, `${label} implementationCommit before validation`);
  object(record.review, ['decision', 'reviewer', 'reviewedAt', 'commit', 'url'], `${label} review`);
  requireCondition(record.review.decision === 'approved', `${label} requires an approved human review`);
  nonempty(record.review.reviewer, `${label} reviewer`);
  requireCondition(typeof record.review.reviewedAt === 'string' && /^\d{4}-\d{2}-\d{2}T/.test(record.review.reviewedAt)
    && Number.isFinite(Date.parse(record.review.reviewedAt)), `${label} reviewedAt must be an ISO timestamp`);
  requireCondition(record.review.commit === record.checkedCommit, `${label} review must cover checkedCommit`);
  httpsUrl(record.review.url, `${label} review URL`);
  requireCondition(Array.isArray(record.checks) && record.checks.length > 0, `${label} requires behavioral validation evidence`);
  for (const check of record.checks) {
    object(check, ['command', 'result', 'evidenceUrl'], `${label} check`);
    nonempty(check.command, `${label} check command`);
    requireCondition(check.result === 'passed', `${label} has a non-passing check`);
    httpsUrl(check.evidenceUrl, `${label} check evidenceUrl`);
  }
  requireCondition(Array.isArray(record.acceptance) && record.acceptance.length > 0, `${label} requires acceptance evidence`);
  for (const item of record.acceptance) {
    object(item, ['criterion', 'evidenceUrl'], `${label} acceptance`);
    nonempty(item.criterion, `${label} acceptance criterion`);
    httpsUrl(item.evidenceUrl, `${label} acceptance evidenceUrl`);
  }
  strings(record.acceptance.map((item) => item.criterion), `${label} acceptance criteria`);
}

export function validatePreflight({
  catalog,
  evidence,
  ticketId,
  targetRef,
  repo = root,
}: ValidatePreflightOptions): PreflightResult {
  const tickets = validateCatalog(catalog);
  const selected = active(tickets, ticketId);
  const targetRevision = commit(repo, targetRef);
  object(evidence, ['schemaVersion', 'targetRevision', 'prerequisites', 'externalContracts'], 'Evidence');
  requireCondition(evidence.schemaVersion === 1, 'Unsupported evidence schemaVersion');
  requireCondition(evidence.targetRevision === targetRevision, `Evidence targetRevision must equal checked revision ${targetRevision}`);
  const dependencies = new Set<string>();
  const contracts = new Set<string>();
  function collect(entry: CatalogTicket): void {
    entry.externalContracts.forEach((id) => contracts.add(id));
    for (const id of entry.prerequisites) {
      const dependency = active(tickets, id);
      if (dependencies.has(id)) continue;
      dependencies.add(id);
      collect(dependency);
    }
  }
  collect(selected);
  for (const [field, required, status] of [
    ['prerequisites', dependencies, 'implemented'],
    ['externalContracts', contracts, 'resolved'],
  ] as const) {
    requireCondition(Array.isArray(evidence[field]), `Evidence ${field} must be an array`);
    const seen = new Set<string>();
    for (const record of evidence[field]) {
      requireCondition(record !== null && typeof record === 'object' && !Array.isArray(record), `Invalid ${field} record`);
      const recordId = record.id;
      nonempty(recordId, `${field} ID`);
      if (field === 'prerequisites') active(tickets, recordId);
      requireCondition(required.has(recordId), `Unexpected ${field} evidence ${recordId}`);
      requireCondition(!seen.has(recordId), `Duplicate ${field} evidence ${recordId}`);
      seen.add(recordId);
      reviewedRecord(record, status, repo, targetRevision);
      if (field === 'prerequisites') {
        const criteria = new Set(record.acceptance.map((item) => item.criterion));
        const ticket = tickets.get(recordId);
        requireCondition(ticket, `Unknown ticket ID ${recordId}`);
        for (const criterion of ticket.requiredAcceptance) {
          requireCondition(criteria.has(criterion), `${recordId} is missing acceptance evidence ${criterion}`);
        }
      }
    }
    for (const id of required) requireCondition(seen.has(id), `Missing reviewed ${field} evidence for ${id}`);
  }
  return { ticket: ticketId, targetRevision, prerequisites: [...dependencies].sort(), externalContracts: [...contracts].sort() };
}

function main(args: readonly string[]): void {
  const catalog = JSON.parse(readFileSync(resolve(root, catalogPath), 'utf8'));
  if (args.length === 1 && args[0] === '--list') {
    validateCatalog(catalog);
    process.stdout.write(`${JSON.stringify(catalog.tickets, null, 2)}\n`);
    return;
  }
  const options = new Map<string, string>();
  for (let index = 0; index < args.length; index += 2) {
    const flag = args[index];
    requireCondition(flag !== undefined && ['--ticket', '--evidence', '--target-ref'].includes(flag), `Unknown argument ${flag}`);
    requireCondition(!options.has(flag), `Duplicate argument ${flag}`);
    const value = args[index + 1];
    requireCondition(value !== undefined && !value.startsWith('--'), `Missing value for ${flag}`);
    options.set(flag, value);
  }
  requireCondition(options.size === 3, 'Usage: node ci/src/actions/debt/validateDebtProjectionTickets.ts --ticket <ID> --evidence <reviewed-evidence.json> --target-ref <ref> (or --list)');
  const ticketId = options.get('--ticket');
  const evidencePath = options.get('--evidence');
  const targetRef = options.get('--target-ref');
  requireCondition(ticketId && evidencePath && targetRef, 'Debt preflight options are incomplete');
  const result = validatePreflight({
    catalog,
    evidence: JSON.parse(readFileSync(resolve(evidencePath), 'utf8')),
    ticketId,
    targetRef,
  });
  process.stdout.write(`PASS debt dependency preflight\n${JSON.stringify(result, null, 2)}\nThis verifies prerequisite evidence structure and ancestry, not implementation acceptance or human approval authenticity.\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try { main(process.argv.slice(2)); }
  catch (error) {
    process.stderr.write(`FAIL debt dependency preflight: ${error instanceof Error ? error.message : 'invalid input'}\n`);
    process.exitCode = 1;
  }
}
