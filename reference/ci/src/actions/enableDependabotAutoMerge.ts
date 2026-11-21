#!/usr/bin/env node

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { isTrustedDependabotUpdate, loadDependabotEvidence } from './dependabotTrust.ts';
import { workflowNames } from '../../../scripts/ci/generated/workflow-names.ts';
import { githubEnable, githubRest } from './nativeAutoMerge.ts';
export { autoMergeConfirmed } from './nativeAutoMerge.ts';

const SHA = /^[a-f0-9]{40}$/;
const IOS_WORKFLOW = workflowNames['ios-tests'].workflow;

function record(value: unknown): Readonly<Record<string, unknown>> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Readonly<Record<string, unknown>> : null;
}

interface Trigger {
  readonly branch: string;
  readonly sha: string;
}

/** A completed PR run is evidence for one exact head, even when GitHub omits pull_requests. */
export function dependabotTrigger(event: unknown, repository: string): Trigger | null {
  const run = record(record(event)?.workflow_run);
  const headRepository = record(run?.head_repository);
  if (run?.name !== IOS_WORKFLOW || run.event !== 'pull_request'
    || run.status !== 'completed' || run.conclusion !== 'success'
    || headRepository?.full_name !== repository
    || typeof run.head_branch !== 'string' || !run.head_branch.startsWith('dependabot/')
    || typeof run.head_sha !== 'string' || !SHA.test(run.head_sha)) return null;
  return { branch: run.head_branch, sha: run.head_sha };
}

interface GithubPorts {
  readonly rest: (path: string) => Promise<unknown>;
  readonly enable: (nodeId: string) => Promise<void>;
}

export type AutoMergeDecision =
  | 'ignored' | 'stale' | 'untrusted' | 'already-enabled' | 'enabled' | 'manual-enqueue-required';

/** Why each decision was reached, as the stable `reason` of the step's JSON log line. */
export const AUTO_MERGE_DECISION_REASONS: Readonly<Record<AutoMergeDecision, string>> = {
  ignored: 'not-a-successful-dependabot-ios-run',
  stale: 'pull-request-head-or-base-moved',
  untrusted: 'change-is-not-a-verified-dependency-update',
  'already-enabled': 'auto-merge-already-enabled',
  enabled: 'auto-merge-enabled',
  'manual-enqueue-required': 'github-actions-change-requires-manual-enqueue',
};

/**
 * A GitHub Actions workflow or action change. On the develop merge queue a
 * candidate runs its own workflow files with repository secrets, where the PR
 * run had only Dependabot secrets, so such a PR is left for a person to
 * enqueue (merge-queue plan S3, review control option B).
 */
export function changesGithubActions(files: readonly unknown[]): boolean {
  return files.some((file) => {
    const filename = record(file)?.filename;
    return typeof filename === 'string' && /^\.github\/(?:workflows|actions)\//.test(filename);
  });
}

/** GitHub's native auto-merge still enforces all required checks and branch rules. */
export async function enableCurrentDependabotAutoMerge(
  event: unknown,
  repository: string,
  ports: GithubPorts,
): Promise<AutoMergeDecision> {
  const trigger = dependabotTrigger(event, repository);
  if (!trigger) return 'ignored';
  const [owner] = repository.split('/');
  if (!owner) throw new Error('Invalid GitHub repository');
  const candidates = await ports.rest(`pulls?state=open&head=${encodeURIComponent(`${owner}:${trigger.branch}`)}&per_page=100`);
  if (!Array.isArray(candidates) || candidates.length !== 1) return 'stale';
  const candidate = record(candidates[0]);
  if (!Number.isSafeInteger(candidate?.number)) return 'stale';
  const number = Number(candidate?.number);
  const load = async () => record(await ports.rest(`pulls/${number}`));
  const initial = await load();
  const currentHead = (pr: Readonly<Record<string, unknown>> | null): boolean => {
    const head = record(pr?.head);
    return pr?.state === 'open' && pr.draft === false && head?.sha === trigger.sha
      && head.ref === trigger.branch && record(head.repo)?.full_name === repository;
  };
  if (!currentHead(initial)) return 'stale';
  if (initial?.auto_merge != null) return 'already-enabled';
  const evidence = await loadDependabotEvidence(number, ports.rest);
  const fresh = await load();
  const initialBase = record(initial?.base);
  const freshBase = record(fresh?.base);
  if (!currentHead(fresh) || fresh?.node_id !== initial?.node_id
    || freshBase?.ref !== initialBase?.ref || freshBase?.sha !== initialBase?.sha) return 'stale';
  if (fresh?.auto_merge != null) return 'already-enabled';
  if (!isTrustedDependabotUpdate(fresh, evidence.files, evidence.commits, evidence.forcePushEvents)) return 'untrusted';
  if (typeof fresh?.node_id !== 'string' || !fresh.node_id) return 'untrusted';
  if (changesGithubActions(evidence.files)) return 'manual-enqueue-required';
  await ports.enable(fresh.node_id);
  return 'enabled';
}

export async function main(): Promise<void> {
  const eventPath = process.env.GITHUB_EVENT_PATH;
  const repository = process.env.GITHUB_REPOSITORY;
  if (!eventPath || !repository) throw new Error('GitHub event path and repository are required');
  const event: unknown = JSON.parse(readFileSync(eventPath, 'utf8'));
  const result = await enableCurrentDependabotAutoMerge(event, repository, {
    rest: githubRest,
    enable: githubEnable,
  });
  console.log(`Dependabot native auto-merge: ${result}.`);
  console.log(JSON.stringify({
    schema: 'example.dependabot-auto-merge.v1', decision: result, reason: AUTO_MERGE_DECISION_REASONS[result],
  }));
  if (result === 'manual-enqueue-required') {
    console.log('::notice::This Dependabot PR changes GitHub Actions; a maintainer must add it to the merge queue.');
  }
}

if (process.argv[1] !== undefined && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  main().catch(error => {
    console.error(error);
    process.exitCode = 1;
  });
}
