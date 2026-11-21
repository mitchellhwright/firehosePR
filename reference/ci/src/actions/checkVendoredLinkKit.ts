import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  LINKKIT_ISSUE_CREATOR,
  LINKKIT_ISSUE_LABELS,
  LINKKIT_ISSUE_TITLE,
  LINKKIT_PACKAGE_PATH,
  LINKKIT_RELEASES_REPOSITORY,
  findTrackingIssue,
  newestStableRelease,
  parseLatestRelease,
  parseReleaseList,
  pinnedLinkKitVersion,
  planIssueAction,
  skippedReleases,
  stableRelease,
  type IssueAction,
} from '../vendoredLinkKit.ts';

/** The GitHub calls the check makes; tests substitute a fake. */
export interface LinkKitGithubPort {
  readonly latestRelease: () => Promise<unknown>;
  readonly releases: () => Promise<unknown>;
  readonly openIssues: () => Promise<unknown>;
  readonly createIssue: (title: string, body: string, labels: readonly string[]) => Promise<number>;
  readonly updateIssue: (issueNumber: number, body: string) => Promise<void>;
  readonly closeIssue: (issueNumber: number, comment: string) => Promise<void>;
}

export interface LinkKitCheckOptions {
  readonly packageSwift: string;
  readonly github: LinkKitGithubPort;
  readonly dryRun: boolean;
  readonly log: (message: string) => void;
}

async function applyAction(action: IssueAction, github: LinkKitGithubPort): Promise<string> {
  switch (action.kind) {
    case 'create': {
      const issueNumber = await github.createIssue(LINKKIT_ISSUE_TITLE, action.body, LINKKIT_ISSUE_LABELS);
      return `Opened issue #${issueNumber}.`;
    }
    case 'update':
      await github.updateIssue(action.number, action.body);
      return `Updated issue #${action.number}.`;
    case 'close':
      await github.closeIssue(action.number, action.comment);
      return `Closed issue #${action.number}.`;
    case 'none':
      return `No issue change: ${action.reason}.`;
  }
}

function describeAction(action: IssueAction): string {
  switch (action.kind) {
    case 'create':
      return 'would open a tracking issue';
    case 'update':
      return `would update issue #${action.number}`;
    case 'close':
      return `would close issue #${action.number}`;
    case 'none':
      return `no issue change: ${action.reason}`;
  }
}

/** Compares the pinned LinkKit with Plaid's latest release and reconciles the tracking issue. */
export async function runLinkKitCheck(options: LinkKitCheckOptions): Promise<IssueAction> {
  const { github, log } = options;
  const pinned = pinnedLinkKitVersion(options.packageSwift);
  const designated = stableRelease(parseLatestRelease(await github.latestRelease()));
  const listed = parseReleaseList(await github.releases());
  const latest = newestStableRelease(designated === undefined ? listed : [...listed, designated]);
  if (latest === undefined) {
    const action: IssueAction = {
      kind: 'none',
      reason: `${LINKKIT_RELEASES_REPOSITORY} has no published, non-prerelease MAJOR.MINOR.PATCH release`,
    };
    log(`::warning::${action.reason}; leaving the tracking issue unchanged.`);
    return action;
  }
  const skipped = skippedReleases(listed, pinned, latest.version);
  const openIssue = findTrackingIssue(await github.openIssues());
  const action = planIssueAction({ pinned, latest, skipped, openIssue });
  log(`Pinned LinkKit ${pinned.text}; latest ${latest.version.text} (${latest.url}).`);
  if (options.dryRun) {
    log(`Dry run: ${describeAction(action)}.`);
    if (action.kind === 'create' || action.kind === 'update') log(action.body);
    return action;
  }
  log(await applyAction(action, github));
  return action;
}

function requiredEnvironment(name: string): string {
  const value = process.env[name];
  if (value === undefined || value === '') {
    throw new Error(`${name} is required (the workflow passes it; set it locally for a dry run)`);
  }
  return value;
}

type Requester = (method: string, path: string, body?: unknown) => Promise<unknown>;

function createRequester(apiUrl: string, token: string): Requester {
  return async (method, path, body) => {
    const url = `${apiUrl}${path}`;
    const response = await fetch(url, {
      method,
      headers: {
        Accept: 'application/vnd.github+json',
        Authorization: `Bearer ${token}`,
        'X-GitHub-Api-Version': '2022-11-28',
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    if (!response.ok) {
      throw new Error(`${method} ${url} returned HTTP ${response.status}: ${await response.text()}`);
    }
    return response.json() as Promise<unknown>;
  };
}

function issueNumberFrom(payload: unknown): number {
  const value = typeof payload === 'object' && payload !== null && 'number' in payload
    ? payload.number
    : undefined;
  if (typeof value !== 'number') throw new Error('GitHub created an issue but returned no issue number');
  return value;
}

export function createGithubPort(apiUrl: string, repository: string, token: string): LinkKitGithubPort {
  const request = createRequester(apiUrl.replace(/\/$/, ''), token);
  const releasesPath = `/repos/${LINKKIT_RELEASES_REPOSITORY}/releases`;
  const issuesPath = `/repos/${repository}/issues`;
  // The workflow's GITHUB_TOKEN opens the issue, so it is found by its author
  // rather than by labels a maintainer may remove.
  const creator = encodeURIComponent(LINKKIT_ISSUE_CREATOR);
  const releases = async (): Promise<unknown> => {
    const pageSize = 100;
    const all: unknown[] = [];
    for (let page = 1; page <= 100; page += 1) {
      const listed = await request('GET', `${releasesPath}?per_page=${pageSize}&page=${page}`);
      if (!Array.isArray(listed)) throw new Error('Plaid release listing was not an array');
      all.push(...listed);
      if (listed.length < pageSize) return all;
    }
    throw new Error('Plaid release listing exceeded 100 pages; refusing an incomplete comparison');
  };
  const openIssues = async (): Promise<unknown> => {
    const pageSize = 100;
    for (let page = 1; page <= 100; page += 1) {
      const issues = await request('GET', `${issuesPath}?state=open&creator=${creator}&per_page=${pageSize}&page=${page}`);
      if (findTrackingIssue(issues) !== undefined || (Array.isArray(issues) && issues.length < pageSize)) {
        return issues;
      }
    }
    throw new Error('Tracking-issue search exceeded 100 pages; refusing to create a duplicate issue');
  };
  return {
    latestRelease: () => request('GET', `${releasesPath}/latest`),
    releases,
    openIssues,
    createIssue: async (title, body, issueLabels) =>
      issueNumberFrom(await request('POST', issuesPath, { title, body, labels: issueLabels })),
    updateIssue: async (issueNumber, body) => {
      await request('PATCH', `${issuesPath}/${issueNumber}`, { body });
    },
    closeIssue: async (issueNumber, comment) => {
      await request('POST', `${issuesPath}/${issueNumber}/comments`, { body: comment });
      await request('PATCH', `${issuesPath}/${issueNumber}`, { state: 'closed', state_reason: 'completed' });
    },
  };
}

export async function main(argv: readonly string[] = process.argv.slice(2)): Promise<void> {
  const dryRun = argv.includes('--dry-run') || process.env['LINKKIT_CHECK_DRY_RUN'] === 'true';
  const github = createGithubPort(
    process.env['GITHUB_API_URL'] ?? 'https://api.github.com',
    requiredEnvironment('GITHUB_REPOSITORY'),
    requiredEnvironment('GITHUB_TOKEN'),
  );
  await runLinkKitCheck({
    packageSwift: readFileSync(LINKKIT_PACKAGE_PATH, 'utf8'),
    github,
    dryRun,
    log: (message) => console.log(message),
  });
}

if (process.argv[1] !== undefined && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  main().catch((error: unknown) => {
    console.error(`::error::${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  });
}
