import { z } from 'zod';

import { isSha40, promotionCheckpointSha } from '../ios/iosGatePrecheck.ts';
import { allTrustedVersionAttestations } from './versionAttestation.ts';

const sha = z.string().refine(isSha40, 'expected a full commit SHA');
const pullSchema = z.object({
  number: z.number().int().positive(),
  node_id: z.string().min(1),
  html_url: z.string().url(),
  state: z.enum(['open', 'closed']),
  draft: z.boolean(),
  title: z.string(),
  body: z.string().nullish(),
  base: z.object({ ref: z.string(), sha }),
  head: z.object({ ref: z.string(), sha, repo: z.object({ full_name: z.string() }) }),
  labels: z.array(z.object({ name: z.string() })).default([]),
});

export type CheckpointPull = z.infer<typeof pullSchema>;

const refSchema = z.object({ object: z.object({ sha }) });
const commitSchema = z.object({
  sha,
  parents: z.array(z.object({ sha })),
  commit: z.object({
    message: z.string(),
    committer: z.object({ name: z.string(), email: z.string() }),
    tree: z.object({ sha }),
    verification: z.object({
      verified: z.boolean(), reason: z.string(), signature: z.string().nullable(),
    }),
  }),
  committer: z.object({ login: z.string(), id: z.number() }).nullable(),
  files: z.array(z.object({ filename: z.string(), status: z.string() })).optional(),
});
export type CheckpointCommit = z.infer<typeof commitSchema>;

const comparisonSchema = z.object({
  status: z.string(),
  merge_base_commit: z.object({ sha }).optional(),
  base_commit: z.object({ sha }).optional(),
  behind_by: z.number().int().optional(),
});
export type CheckpointComparison = z.infer<typeof comparisonSchema>;

const contentSchema = z.object({
  path: z.string(),
  encoding: z.literal('base64'),
  content: z.string(),
});

type Method = 'GET' | 'POST' | 'PATCH' | 'PUT';
export interface ApiResult {
  readonly status: number;
  readonly body: unknown;
}

export class CheckpointApi {
  private readonly baseUrl: string;
  private readonly token: string;
  private readonly repository: string;
  private readonly fetchImpl: typeof fetch;

  constructor(
    baseUrl: string,
    token: string,
    repository: string,
    fetchImpl: typeof fetch = fetch,
  ) {
    this.baseUrl = baseUrl;
    this.token = token;
    this.repository = repository;
    this.fetchImpl = fetchImpl;
  }

  async request(method: Method, path: string, body?: unknown): Promise<ApiResult> {
    const response = await this.fetchImpl(
      `${this.baseUrl.replace(/\/$/u, '')}/repos/${this.repository}/${path}`,
      {
        method,
        headers: {
          Authorization: `Bearer ${this.token}`,
          Accept: 'application/vnd.github+json',
          'Content-Type': 'application/json',
          'X-GitHub-Api-Version': '2022-11-28',
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      },
    );
    const text = await response.text();
    let parsed: unknown;
    try {
      parsed = text.length > 0 ? JSON.parse(text) as unknown : null;
    } catch {
      throw new Error(`GitHub returned malformed JSON for ${method} ${path} (HTTP ${response.status}).`);
    }
    return { status: response.status, body: parsed };
  }

  private async required(method: Method, path: string, body?: unknown): Promise<unknown> {
    const result = await this.request(method, path, body);
    if (result.status < 200 || result.status >= 300) {
      const message = z.object({ message: z.string().optional() }).safeParse(result.body);
      throw new Error(`${method} ${path} failed: HTTP ${result.status}: ${message.success ? message.data.message ?? 'unknown response' : 'unknown response'}`);
    }
    return result.body;
  }

  pull(number: number): Promise<CheckpointPull> {
    return this.required('GET', `pulls/${number}`).then((body) => pullSchema.parse(body));
  }

  async findCheckpoint(owner: string, branch: string): Promise<CheckpointPull | null> {
    const query = new URLSearchParams({ state: 'all', base: 'main', head: `${owner}:${branch}`, per_page: '100' });
    const body = await this.required('GET', `pulls?${query}`);
    const pulls: CheckpointPull[] = [];
    for (const candidate of z.array(z.unknown()).parse(body)) {
      const parsed = pullSchema.safeParse(candidate);
      if (parsed.success) {
        pulls.push(parsed.data);
      } else {
        const state = z.object({ state: z.string().optional() }).safeParse(candidate);
        if (state.success && state.data.state === 'closed') continue;
        throw new Error('GitHub returned malformed open checkpoint pull request data.');
      }
    }
    return pulls.find((pull) => pull.state === 'open') ?? pulls[0] ?? null;
  }

  async ref(branch: string): Promise<string | null> {
    const result = await this.request('GET', `git/ref/heads/${branch}`);
    if (result.status === 404) return null;
    if (result.status !== 200) throw new Error(`Unexpected GitHub response while checking ${branch}: HTTP ${result.status}.`);
    return refSchema.parse(result.body).object.sha;
  }

  async createRef(branch: string, headSha: string): Promise<void> {
    refSchema.parse(await this.required('POST', 'git/refs', { ref: `refs/heads/${branch}`, sha: headSha }));
  }

  async advanceRef(branch: string, headSha: string): Promise<void> {
    refSchema.parse(await this.required('PATCH', `git/refs/heads/${branch}`, { sha: headSha, force: false }));
  }

  async readFile(path: string, commitSha: string): Promise<string> {
    const query = new URLSearchParams({ ref: commitSha });
    const body = contentSchema.parse(await this.required('GET', `contents/${path}?${query}`));
    if (body.path !== path) throw new Error(`GitHub returned the wrong file for ${path}.`);
    return Buffer.from(body.content.replaceAll(/\s/gu, ''), 'base64').toString('utf8');
  }

  async createBlob(content: string): Promise<string> {
    const body = await this.required('POST', 'git/blobs', { content, encoding: 'utf-8' });
    return z.object({ sha }).parse(body).sha;
  }

  async createTree(baseTree: string, path: string, blobSha: string): Promise<string> {
    const body = await this.required('POST', 'git/trees', {
      base_tree: baseTree,
      tree: [{ path, mode: '100644', type: 'blob', sha: blobSha }],
    });
    return z.object({ sha }).parse(body).sha;
  }

  async createCommit(message: string, tree: string, parent: string): Promise<string> {
    const body = await this.required('POST', 'git/commits', { message, tree, parents: [parent] });
    return z.object({ sha }).parse(body).sha;
  }

  async treeForCommit(commitSha: string): Promise<string> {
    const body = await this.required('GET', `git/commits/${commitSha}`);
    return z.object({ tree: z.object({ sha }) }).parse(body).tree.sha;
  }

  async createPull(title: string, branch: string, body: string): Promise<CheckpointPull> {
    return pullSchema.parse(await this.required('POST', 'pulls', {
      title, head: branch, base: 'main', body, draft: true,
    }));
  }

  async setPullState(number: number, state: 'open' | 'closed'): Promise<CheckpointPull> {
    return pullSchema.parse(await this.required('PATCH', `pulls/${number}`, { state }));
  }

  async commit(commitSha: string): Promise<CheckpointCommit> {
    return commitSchema.parse(await this.required('GET', `commits/${commitSha}`));
  }

  async compare(from: string, to: string): Promise<CheckpointComparison> {
    return comparisonSchema.parse(await this.required('GET', `compare/${from}...${to}`));
  }

  updateBranch(number: number, expectedHeadSha: string): Promise<ApiResult> {
    return this.request('PUT', `pulls/${number}/update-branch`, { expected_head_sha: expectedHeadSha });
  }

  async setDraft(nodeId: string, draft: boolean): Promise<{
    readonly isDraft: boolean;
    readonly headSha: string;
    readonly baseSha: string;
    readonly baseRef: string;
  }> {
    const operation = draft ? 'convertPullRequestToDraft' : 'markPullRequestReadyForReview';
    const query = `mutation($id:ID!) { ${operation}(input:{pullRequestId:$id}) { pullRequest { isDraft headRefOid baseRefName baseRef { target { oid } } } } }`;
    const response = await this.fetchImpl(`${this.baseUrl.replace(/\/$/u, '')}/graphql`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.token}`,
        Accept: 'application/vnd.github+json',
        'Content-Type': 'application/json',
        'X-GitHub-Api-Version': '2022-11-28',
      },
      body: JSON.stringify({ query, variables: { id: nodeId } }),
    });
    if (!response.ok) throw new Error(`GitHub did not confirm checkpoint draft=${draft}: HTTP ${response.status}.`);
    const body: unknown = await response.json();
    const schema = z.object({
      data: z.record(z.string(), z.object({
        pullRequest: z.object({
          isDraft: z.boolean(), headRefOid: sha, baseRefName: z.string(),
          baseRef: z.object({ target: z.object({ oid: sha }) }),
        }),
      })),
    });
    const pull = schema.parse(body).data[operation]?.pullRequest;
    if (pull === undefined || pull.isDraft !== draft) {
      throw new Error(`GitHub did not confirm checkpoint draft=${draft}.`);
    }
    return {
      isDraft: pull.isDraft, headSha: pull.headRefOid,
      baseSha: pull.baseRef.target.oid, baseRef: pull.baseRefName,
    };
  }

  async addLabels(number: number, labels: readonly string[]): Promise<void> {
    await this.required('POST', `issues/${number}/labels`, { labels });
  }

  async comment(number: number, body: string): Promise<unknown> {
    return this.required('POST', `issues/${number}/comments`, { body });
  }

  async comments(number: number): Promise<unknown[]> {
    const all: unknown[] = [];
    for (let page = 1; page <= 20; page += 1) {
      const batch = z.array(z.unknown()).parse(await this.required(
        'GET', `issues/${number}/comments?per_page=100&page=${page}`,
      ));
      all.push(...batch);
      if (batch.length < 100) return all;
    }
    throw new Error(`Checkpoint #${number} has too many comments to verify its version attestation.`);
  }

  /** Reserve independent active promotions, not older checkpoints superseded by this source. */
  async promotionVersionReservations(currentSourceSha: string): Promise<string[]> {
    sha.parse(currentSourceSha);
    const versions = new Set<string>();
    const supersededSources = new Map<string, boolean>();
    const isSuperseded = async (sourceSha: string): Promise<boolean> => {
      // An exact-source retry retains its reservation. Only a newer develop
      // descendant can replace an older checkpoint in the same release line.
      if (sourceSha === currentSourceSha) return false;
      const cached = supersededSources.get(sourceSha);
      if (cached !== undefined) return cached;
      const comparison = await this.compare(sourceSha, currentSourceSha);
      const superseded = comparison.status === 'ahead'
        && comparison.behind_by === 0
        && comparison.merge_base_commit?.sha === sourceSha;
      supersededSources.set(sourceSha, superseded);
      return superseded;
    };
    const listing = z.array(z.object({
      number: z.number().int().positive(),
      base: z.object({ ref: z.string() }),
      head: z.object({ ref: z.string() }),
    }));
    for (let page = 1; page <= 20; page += 1) {
      const pulls = listing.parse(await this.required(
        'GET', `pulls?state=open&base=main&per_page=100&page=${page}`,
      ));
      for (const pull of pulls) {
        if (pull.base.ref !== 'main'
          || (pull.head.ref !== 'develop' && promotionCheckpointSha(pull.head.ref) === null)) continue;
        for (const attestation of allTrustedVersionAttestations(await this.comments(pull.number))) {
          if (pull.head.ref === 'develop'
            || attestation.sourceSha === promotionCheckpointSha(pull.head.ref)) {
            if (!await isSuperseded(attestation.sourceSha)) versions.add(attestation.version);
          }
        }
      }
      if (pulls.length < 100) return [...versions];
    }
    throw new Error('Promotion PR history exceeds the bounded version-reservation inventory.');
  }
}
