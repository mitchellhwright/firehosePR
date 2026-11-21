#!/usr/bin/env node

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { githubAuthorPermission, githubEnable, githubRest } from './nativeAutoMerge.ts';

function record(value: unknown): Readonly<Record<string, unknown>> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Readonly<Record<string, unknown>> : null;
}

const SHA = /^[a-f0-9]{40}$/;
const ACTIONS = new Set(['opened', 'reopened', 'ready_for_review', 'synchronize', 'edited']);

export type Decision = 'ignored' | 'stale' | 'already-enabled' | 'enabled';

interface Ports {
  readonly rest: (path: string) => Promise<unknown>;
  readonly authorPermission: (login: string) => Promise<unknown>;
  readonly enable: (nodeId: string) => Promise<void>;
}

/** Record merge intent only; GitHub remains the authority for review and required checks. */
export async function enableInternalPrAutoMerge(
  event: unknown, repository: string, ports: Ports,
): Promise<Decision> {
  const envelope = record(event);
  const eventPr = record(envelope?.pull_request);
  const eventHead = record(eventPr?.head);
  const eventBase = record(eventPr?.base);
  const number = eventPr?.number;
  const sha = eventHead?.sha;
  const author = record(eventPr?.user)?.login;
  if (!ACTIONS.has(String(envelope?.action)) || !Number.isSafeInteger(number)
    || typeof sha !== 'string' || !SHA.test(sha)
    || typeof author !== 'string' || author.length === 0
    || eventBase?.ref !== 'develop' || record(eventBase.repo)?.full_name !== repository
    || record(eventHead?.repo)?.full_name !== repository
    || eventPr?.draft !== false || record(eventPr?.user)?.type !== 'User') return 'ignored';

  // A base retarget can make an edited event relevant; ordinary text edits do not.
  if (envelope?.action === 'edited' && record(envelope.changes)?.base == null) return 'ignored';

  const initial = record(await ports.rest(`pulls/${number}`));
  const current = (pr: Readonly<Record<string, unknown>> | null): boolean => {
    const head = record(pr?.head);
    const base = record(pr?.base);
    return pr?.state === 'open' && pr?.draft === false && pr?.number === number
      && head?.sha === sha && record(head.repo)?.full_name === repository
      && base?.ref === 'develop' && record(base.repo)?.full_name === repository
      && record(pr?.user)?.type === 'User' && record(pr?.user)?.login === author;
  };
  if (!current(initial)) return 'stale';
  if (initial?.auto_merge != null) return 'already-enabled';

  // Same-repository branch access does not prove the author may request a
  // merge. GitHub reports the effective repository permission across direct,
  // team, organization, and enterprise grants; unknown or read-only is denied.
  const access = record(await ports.authorPermission(author));
  if (!['write', 'admin'].includes(String(access?.permission))
    || record(access?.user)?.login !== author) return 'ignored';

  // Confirm the exact head and base again immediately before the mutation.
  const fresh = record(await ports.rest(`pulls/${number}`));
  if (!current(fresh) || fresh?.node_id !== initial?.node_id
    || record(fresh?.base)?.sha !== record(initial?.base)?.sha) return 'stale';
  if (fresh?.auto_merge != null) return 'already-enabled';
  if (typeof fresh?.node_id !== 'string' || !fresh.node_id) return 'stale';
  await ports.enable(fresh.node_id);
  return 'enabled';
}

export async function main(): Promise<void> {
  const eventPath = process.env.GITHUB_EVENT_PATH;
  const repository = process.env.GITHUB_REPOSITORY;
  if (!eventPath || !repository) throw new Error('GitHub event path and repository are required');
  const event: unknown = JSON.parse(readFileSync(eventPath, 'utf8'));
  const decision = await enableInternalPrAutoMerge(event, repository, {
    rest: githubRest, authorPermission: githubAuthorPermission, enable: githubEnable,
  });
  console.log(JSON.stringify({ schema: 'example.internal-pr-auto-merge.v1', decision }));
}

if (process.argv[1] !== undefined && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  main().catch(error => {
    console.error(error);
    process.exitCode = 1;
  });
}
