import { VIDEO_FINDING_IDENTITIES } from './identities.ts';

const ROOT = 'https://api.github.com/repos/example-org/example-app';
const canonicalNumbers = new Set<number>(
  Object.values(VIDEO_FINDING_IDENTITIES).map(value => value.canonicalIssue),
);

type FetchImplementation = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;

export interface VideoIssue {
  readonly number: number;
  readonly state: string;
  readonly body: string;
}

export interface VideoComment {
  readonly id: number;
  readonly body: string;
  readonly user: { readonly login: string };
  readonly createdAt: string;
}

export interface VideoFindingApi {
  readonly writerLogin: string;
  readonly getIssue: (number: number) => Promise<VideoIssue>;
  readonly listComments: (number: number) => Promise<readonly VideoComment[]>;
  readonly updateLedgerComment: (
    number: number,
    expected: VideoComment,
    body: string,
  ) => Promise<VideoComment>;
  readonly postComment: (number: number, body: string) => Promise<VideoComment>;
}

export interface CreateVideoFindingGitHubInput {
  readonly token: string | undefined;
  readonly writerLogin: string;
  readonly fetchImpl?: FetchImplementation;
}

function record(value: unknown): Readonly<Record<string, unknown>> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Readonly<Record<string, unknown>>
    : undefined;
}

function parseComment(value: unknown): VideoComment {
  const candidate = record(value);
  const user = record(candidate?.['user']);
  const id = candidate?.['id'];
  const body = candidate?.['body'];
  const login = user?.['login'];
  const createdAt = candidate?.['created_at'];
  if (!Number.isSafeInteger(id) || typeof id !== 'number' || id <= 0
    || typeof body !== 'string' || typeof login !== 'string' || login.length === 0
    || typeof createdAt !== 'string' || !Number.isFinite(Date.parse(createdAt))) {
    throw new Error('Invalid GitHub video comment response');
  }
  return { id, body, user: { login }, createdAt };
}

function parseIssue(value: unknown, number: number): VideoIssue {
  const candidate = record(value);
  if (candidate?.['number'] !== number || !['open', 'closed'].includes(String(candidate['state']))
    || typeof candidate['body'] !== 'string' || candidate['pull_request']) {
    throw new Error('Invalid GitHub video issue response');
  }
  return { number, state: String(candidate['state']), body: candidate['body'] };
}

export function createVideoFindingGitHub(input: CreateVideoFindingGitHubInput): VideoFindingApi {
  const { token, writerLogin, fetchImpl = fetch } = input;
  if (typeof token !== 'string' || token.length === 0 || /\s/.test(token)
    || !/^[a-zA-Z0-9-]+(?:\[bot\])?$/.test(writerLogin)) {
    throw new Error('GitHub video writer credentials required');
  }
  function issuePath(number: number): string {
    if (!canonicalNumbers.has(number)) throw new Error('Unregistered video canonical issue');
    return `${ROOT}/issues/${number}`;
  }
  async function request(url: string, method = 'GET', body?: unknown): Promise<unknown> {
    let response: Response;
    try {
      response = await fetchImpl(url, {
        method,
        redirect: 'error',
        signal: AbortSignal.timeout(15_000),
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: 'application/vnd.github+json',
          'X-GitHub-Api-Version': '2022-11-28',
          ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
    } catch {
      throw new Error('GitHub video request failed; replay saved results');
    }
    if (!response.ok) {
      throw new Error(`GitHub video request failed (HTTP ${response.status}); replay saved results`);
    }
    try {
      return await response.json();
    } catch {
      throw new Error('Invalid GitHub video JSON response');
    }
  }
  async function readComments(number: number): Promise<readonly VideoComment[]> {
    const base = issuePath(number);
    const comments: VideoComment[] = [];
    const seen = new Set<number>();
    for (let page = 1; page <= 100; page += 1) {
      const values = await request(`${base}/comments?per_page=100&page=${page}`);
      if (!Array.isArray(values) || values.length > 100) {
        throw new Error('Invalid GitHub video comments page');
      }
      for (const value of values) {
        const parsed = parseComment(value);
        if (seen.has(parsed.id)) throw new Error('GitHub video comments changed during pagination');
        seen.add(parsed.id);
        comments.push(parsed);
      }
      if (values.length < 100) return comments;
    }
    throw new Error('GitHub video comment pagination limit reached');
  }
  return {
    writerLogin,
    async getIssue(number) {
      return parseIssue(await request(issuePath(number)), number);
    },
    async updateLedgerComment(number, expected, body) {
      const base = issuePath(number);
      if (!Number.isSafeInteger(expected.id) || expected.id <= 0 || expected.user.login !== writerLogin
        || typeof expected.body !== 'string'
        || !expected.body.trimStart().startsWith('<!-- example-video-occurrence-ledger -->')
        || typeof body !== 'string' || body.length > 60_000
        || !body.trimStart().startsWith('<!-- example-video-occurrence-ledger -->')) {
        throw new Error('Invalid video ledger comment update');
      }
      const url = `${ROOT}/issues/comments/${expected.id}`;
      const currentValue = await request(url);
      const current = parseComment(currentValue);
      if (record(currentValue)?.['issue_url'] !== base || current.id !== expected.id
        || current.user.login !== writerLogin || current.body !== expected.body) {
        throw new Error('Video ledger comment changed; replay saved results');
      }
      const receipt = parseComment(await request(url, 'PATCH', { body }));
      if (receipt.id !== expected.id || receipt.user.login !== writerLogin || receipt.body !== body) {
        throw new Error('GitHub video writer receipt mismatch');
      }
      return receipt;
    },
    async listComments(number) {
      const first = await readComments(number);
      const second = await readComments(number);
      // Offset pagination can silently skip a comment when an earlier one is
      // deleted. Require two matching full reads, including edits to markers.
      if (JSON.stringify(first) !== JSON.stringify(second)) {
        throw new Error('GitHub video comments changed during pagination');
      }
      return second;
    },
    async postComment(number, body) {
      if (typeof body !== 'string' || body.length === 0 || body.length > 60_000) {
        throw new Error('Invalid video comment body');
      }
      const receipt = parseComment(await request(`${issuePath(number)}/comments`, 'POST', { body }));
      if (receipt.user.login !== writerLogin || receipt.body !== body) {
        throw new Error('GitHub video writer receipt mismatch');
      }
      return receipt;
    },
  };
}
