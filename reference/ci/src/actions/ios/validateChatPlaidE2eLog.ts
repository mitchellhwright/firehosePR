#!/usr/bin/env node

import fs from 'node:fs';
import { z } from 'zod';

const ANSI_PATTERN = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, 'g');
const MATCH_MARKER = 'CHAT_PLAID_MATCH_EVIDENCE=';
const FALLBACK_MARKER = 'CHAT_PLAID_FALLBACK_EVIDENCE=';
const LINK_MARKER = 'CHAT_PLAID_LINK_EVIDENCE=';
const EXPECTED_ITEMS_ADDITIONAL_CONSENT = ['investments', 'liabilities'];

const requestSchema = z.object({
  institutionId: z.string().nullable().optional(),
  requiredProducts: z.array(z.string()).optional(),
  additionalConsentedProducts: z.array(z.string()).optional(),
  accountFilters: z.unknown().optional(),
  transactions: z.object({ daysRequested: z.number().optional() }).passthrough().optional(),
}).passthrough();
const evidenceRecordSchema = z.object({
  event: z.string().optional(),
  authUserId: z.string().optional(),
  userId: z.string().optional(),
  detectedInstitutionName: z.string().optional(),
  matchedInstitutionName: z.string().optional(),
  institutionId: z.string().optional(),
  flow: z.string().optional(),
  rejectedInstitutionId: z.string().optional(),
  plaidErrorCode: z.string().optional(),
  rejectedRequest: requestSchema.optional(),
  retryRequest: requestSchema.optional(),
  plaidItemDbId: z.string().optional(),
  plaidItemDbIds: z.array(z.string()).optional(),
  institutionName: z.string().optional(),
  institutionNames: z.array(z.string()).optional(),
  status: z.number().optional(),
  itemsTriggered: z.number().optional(),
  skipped: z.string().nullable().optional(),
  reason: z.string().optional(),
  syncStatus: z.string().optional(),
  severity: z.string().optional(),
  items: z.array(z.object({
    plaidItemDbId: z.string().optional(),
    institutionName: z.string().optional(),
    syncStatus: z.string().optional(),
    severity: z.string().optional(),
  }).passthrough()).optional(),
}).passthrough();
type EvidenceRecord = z.output<typeof evidenceRecordSchema>;

interface ParsedRecord {
  readonly lineIndex: number;
  readonly record: EvidenceRecord;
}

function fail(message: string): never {
  process.stderr.write(`Chat Plaid E2E evidence failed: ${message}\n`);
  process.exit(1);
}

function parseLeadingJSONObject(raw: string): unknown {
  const value = raw.trimStart();
  const stack: string[] = [];
  let inString = false;
  let escaped = false;

  for (let index = 0; index < value.length; index += 1) {
    const character = value[index];
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (character === '\\') {
        escaped = true;
      } else if (character === '"') {
        inString = false;
      }
      continue;
    }

    if (character === '"') {
      inString = true;
    } else if (character === '{' || character === '[') {
      stack.push(character);
    } else if (character === '}' || character === ']') {
      const expected = character === '}' ? '{' : '[';
      if (stack.pop() !== expected) throw new SyntaxError('mismatched JSON delimiters');
      if (stack.length === 0) return JSON.parse(value.slice(0, index + 1));
    }
  }

  throw new SyntaxError('unterminated JSON object');
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function parseRecords(log: string, marker: string): ParsedRecord[] {
  return log
    .replace(ANSI_PATTERN, '')
    .split(/\r?\n/)
    .flatMap((line, lineIndex) => {
      const markerIndex = line.indexOf(marker);
      if (markerIndex < 0) return [];
      const json = line.slice(markerIndex + marker.length).trim();
      try {
        return [{ lineIndex, record: evidenceRecordSchema.parse(parseLeadingJSONObject(json)) }];
      } catch (error) {
        fail(`invalid JSON after ${marker}: ${errorMessage(error)}`);
      }
    });
}

function comparableRequest(request: z.output<typeof requestSchema> | undefined): Readonly<Record<string, unknown>> {
  return {
    requiredProducts: request?.requiredProducts,
    additionalConsentedProducts: request?.additionalConsentedProducts,
    accountFilters: request?.accountFilters,
    transactions: request?.transactions,
  };
}

function sanitizedLinkEvidence(record: EvidenceRecord): Readonly<Record<string, unknown>> {
  const base = {
    event: record.event,
    authUserId: record.authUserId,
    userId: record.userId,
  };

  switch (record.event) {
    case 'token_exchange_persisted':
      return {
        ...base,
        plaidItemDbId: record.plaidItemDbId,
        institutionName: record.institutionName,
        status: record.status,
      };
    case 'sync_request_accepted':
      return {
        ...base,
        plaidItemDbIds: record.plaidItemDbIds,
        itemsTriggered: record.itemsTriggered,
        skipped: record.skipped,
        status: record.status,
      };
    case 'connected_accounts_readback':
      return {
        ...base,
        plaidItemDbIds: record.plaidItemDbIds,
        institutionNames: record.institutionNames,
        status: record.status,
      };
    case 'post_link_prime_completed':
      return {
        ...base,
        plaidItemDbId: record.plaidItemDbId,
        institutionName: record.institutionName,
        reason: record.reason,
        syncStatus: record.syncStatus,
      };
    case 'sync_health_readback':
      return {
        ...base,
        status: record.status,
        items: (record.items ?? []).map((item) => ({
          plaidItemDbId: item.plaidItemDbId,
          institutionName: item.institutionName,
          syncStatus: item.syncStatus,
          severity: item.severity,
        })),
      };
    default:
      fail(`unsupported link evidence event: ${record.event}`);
  }
}

const logPath = process.argv[2];
const outputFlagIndex = process.argv.indexOf('--output');
const outputPath = outputFlagIndex >= 0 ? process.argv[outputFlagIndex + 1] : undefined;
if (!logPath || (outputFlagIndex >= 0 && !outputPath)) {
  fail('usage: validateChatPlaidE2eLog.ts <backend-log> [--output <evidence-json>]');
}
if (!fs.existsSync(logPath)) fail(`backend log does not exist: ${logPath}`);

const log = fs.readFileSync(logPath, 'utf8');
const normalizedLog = log.replace(ANSI_PATTERN, '');
const invalidInstitutionConsentRetry = normalizedLog
  .split(/\r?\n/)
  .find((line) =>
    line.includes('INVALID_INSTITUTION')
    && line.includes('failed with additional_consented_products'),
  );
if (invalidInstitutionConsentRetry) {
  fail('stale institution was retried after removing additional consent scope');
}

const matchEntry = parseRecords(log, MATCH_MARKER).find(({ record }) =>
  record.detectedInstitutionName === 'Citi'
  && record.matchedInstitutionName === 'Citibank Online'
  && record.institutionId === 'ins_5'
);
if (!matchEntry) fail('missing exact Citi to Citibank Online (ins_5) match evidence');

const match = matchEntry.record;
if (typeof match.authUserId !== 'string' || match.authUserId.length === 0) {
  fail('Citi institution match evidence is missing its authenticated user correlation');
}

const fallbackEntry = parseRecords(log, FALLBACK_MARKER).find(({ lineIndex, record }) =>
  lineIndex > matchEntry.lineIndex
  && record.authUserId === match.authUserId
  && record.flow === 'items'
  && record.rejectedInstitutionId === 'ins_stale_chat_match'
  && record.plaidErrorCode === 'INVALID_INSTITUTION'
);
if (!fallbackEntry) {
  fail('missing stale Chat institution fallback evidence for the same authenticated user');
}
const fallback = fallbackEntry.record;
if (fallback.rejectedRequest?.institutionId !== 'ins_stale_chat_match') {
  fail('rejected request did not contain the injected stale institution ID');
}
const retryRequest = fallback.retryRequest;
if (!retryRequest || retryRequest.institutionId !== null) {
  fail('fallback retry still contained an institution ID');
}
if (JSON.stringify(comparableRequest(fallback.rejectedRequest))
    !== JSON.stringify(comparableRequest(retryRequest))) {
  fail('fallback changed products, account filters, or transaction history scope');
}
if (JSON.stringify(retryRequest.requiredProducts) !== JSON.stringify(['transactions'])) {
  fail('items fallback did not require Transactions');
}
if (JSON.stringify(retryRequest.additionalConsentedProducts)
    !== JSON.stringify(EXPECTED_ITEMS_ADDITIONAL_CONSENT)) {
  fail('items fallback did not preserve the required additional consent scope');
}
if (Object.hasOwn(retryRequest, 'accountFilters')) {
  fail('items fallback unexpectedly restricted the filter-free account request');
}
if (retryRequest.transactions?.daysRequested !== 730) {
  fail('items fallback did not preserve the 730-day transaction request');
}

const linkEntries = parseRecords(log, LINK_MARKER);
const tokenExchangeEntry = linkEntries.find(({ lineIndex, record }) =>
  lineIndex > fallbackEntry.lineIndex
  && record.event === 'token_exchange_persisted'
  && record.authUserId === match.authUserId
  && typeof record.userId === 'string'
  && record.userId.length > 0
  && typeof record.plaidItemDbId === 'string'
  && record.plaidItemDbId.length > 0
  && record.institutionName === 'First Platypus Bank'
  && record.status === 200
);
if (!tokenExchangeEntry) {
  fail(
    'missing completed Plaid token exchange with persisted First Platypus Bank '
      + 'evidence for the same authenticated user',
  );
}

const tokenExchange = tokenExchangeEntry.record;
if (
  typeof tokenExchange.userId !== 'string' ||
  typeof tokenExchange.plaidItemDbId !== 'string'
) {
  fail('token exchange correlation is incomplete');
}
const correlation = {
  authUserId: match.authUserId,
  userId: tokenExchange.userId,
  plaidItemDbId: tokenExchange.plaidItemDbId,
};
const isCorrelatedRecord = (record: EvidenceRecord): boolean =>
  record.authUserId === correlation.authUserId
  && record.userId === correlation.userId;
const includesCorrelatedItem = (values: readonly string[] | undefined): boolean =>
  Array.isArray(values) && values.includes(correlation.plaidItemDbId);

const syncEntry = linkEntries.find(({ lineIndex, record }) =>
  lineIndex > tokenExchangeEntry.lineIndex
  && record.event === 'sync_request_accepted'
  && isCorrelatedRecord(record)
  && includesCorrelatedItem(record.plaidItemDbIds)
  && record.status === 202
);
if (!syncEntry) {
  const mismatchedInternalUser = linkEntries.find(({ lineIndex, record }) =>
    lineIndex > tokenExchangeEntry.lineIndex
    && record.event === 'sync_request_accepted'
    && record.authUserId === correlation.authUserId
    && includesCorrelatedItem(record.plaidItemDbIds)
    && record.status === 202
    && record.userId !== correlation.userId
  );
  if (mismatchedInternalUser) {
    fail('post-link sync request did not belong to the same internal user');
  }
  fail('missing accepted post-link sync request for the same Plaid item');
}
const syncItemsTriggered = syncEntry.record.itemsTriggered;
if (typeof syncItemsTriggered !== 'number' || !Number.isInteger(syncItemsTriggered) || syncItemsTriggered < 0) {
  fail('post-link sync acknowledgement is missing a valid itemsTriggered count');
}
if (syncEntry.record.skipped !== null && typeof syncEntry.record.skipped !== 'string') {
  fail('post-link sync acknowledgement has an invalid skipped reason');
}
if (syncEntry.record.skipped === 'no_items') {
  fail('post-link sync acknowledgement incorrectly reported no items after persistence');
}

const terminalSyncEntry = linkEntries.find(({ lineIndex, record }) =>
  lineIndex > tokenExchangeEntry.lineIndex
  && record.event === 'post_link_prime_completed'
  && isCorrelatedRecord(record)
  && record.plaidItemDbId === correlation.plaidItemDbId
  && record.institutionName === 'First Platypus Bank'
  && record.reason === 'post-link-account-prime'
  && record.syncStatus === 'synced'
);
if (!terminalSyncEntry) {
  fail('First Platypus Bank never reached a terminal synced state for the same Plaid item');
}

const accountReadbackEntry = linkEntries.find(({ lineIndex, record }) =>
  lineIndex > tokenExchangeEntry.lineIndex
  && record.event === 'connected_accounts_readback'
  && isCorrelatedRecord(record)
  && includesCorrelatedItem(record.plaidItemDbIds)
  && Array.isArray(record.institutionNames)
  && record.institutionNames.includes('First Platypus Bank')
  && record.status === 200
);
if (!accountReadbackEntry) {
  fail('missing successful Connected Accounts readback for the same persisted Plaid item');
}

const syncHealthReadbackEntry = linkEntries.find(({ lineIndex, record }) =>
  lineIndex > terminalSyncEntry.lineIndex
  && record.event === 'sync_health_readback'
  && isCorrelatedRecord(record)
  && record.status === 200
  && Array.isArray(record.items)
  && record.items.some((item) =>
    item.plaidItemDbId === correlation.plaidItemDbId
    && item.institutionName === 'First Platypus Bank'
    && item.syncStatus === 'synced'
    && item.severity === 'ok'
  )
);
if (!syncHealthReadbackEntry) {
  fail('missing successful Sync Health readback for the same Plaid item after terminal sync');
}

const linkCompletion = {
  tokenExchangeStatus: 200,
  syncRequestStatus: syncEntry.record.status,
  syncItemsTriggered: syncEntry.record.itemsTriggered,
  syncSkipped: syncEntry.record.skipped,
  institutionName: 'First Platypus Bank',
  postLinkReason: 'post-link-account-prime',
  terminalSyncStatus: 'synced',
  connectedAccountsReadStatus: 200,
  syncHealthReadStatus: 200,
};
const evidenceChain = [
  tokenExchangeEntry,
  syncEntry,
  accountReadbackEntry,
  terminalSyncEntry,
  syncHealthReadbackEntry,
]
  .sort((left, right) => left.lineIndex - right.lineIndex)
  .map(({ record }) => sanitizedLinkEvidence(record));

if (outputPath) {
  fs.writeFileSync(
    outputPath,
    `${JSON.stringify({
      schemaVersion: 6,
      correlation,
      institutionMatch: match,
      institutionFallback: fallback,
      linkCompletion,
      evidenceChain,
    }, null, 2)}\n`,
  );
}

process.stdout.write(
  'Chat Plaid E2E evidence verified: server Citi match, stale-ID fallback, '
    + 'token exchange, correlated sync acknowledgement, persistence, terminal sync, '
    + 'and Connected Accounts readback.\n',
);
