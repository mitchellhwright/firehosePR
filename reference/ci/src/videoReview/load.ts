import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';

import { validateVideoProducerMetadata, validateVideoReviewArtifact } from './artifact.ts';

const ROOT = 'https://api.github.com/repos/example-org/example-app';
const ARCHIVE_LIMIT = 256_000_000;

type FetchImplementation = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;

export interface LoadVideoReviewInput {
  readonly token: string | undefined;
  readonly runId: string | undefined;
  readonly runAttempt: string | undefined;
  readonly fetchImpl?: FetchImplementation;
}

function record(value: unknown): Readonly<Record<string, unknown>> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Readonly<Record<string, unknown>>
    : undefined;
}

export function extractVideoReviewJson(bytes: Uint8Array): string {
  try {
    return execFileSync(
      'python3',
      [fileURLToPath(new URL('../../../scripts/extract-video-review-json.py', import.meta.url))],
      {
        input: bytes,
        encoding: 'utf8',
        maxBuffer: 2_100_000,
        timeout: 10_000,
        stdio: ['pipe', 'pipe', 'pipe'],
      },
    );
  } catch {
    throw new Error('Invalid video review archive');
  }
}

async function responseBytes(response: Response, limit: number): Promise<Buffer> {
  if (!response.ok) throw new Error(`Video artifact request failed (HTTP ${response.status})`);
  if (response.body === null) throw new Error('Video artifact response unavailable or oversized');
  const chunks: Buffer[] = [];
  let size = 0;
  try {
    for await (const chunk of response.body) {
      size += chunk.length;
      if (size > limit) throw new Error('size');
      chunks.push(Buffer.from(chunk));
    }
  } catch {
    throw new Error('Video artifact response unavailable or oversized');
  }
  return Buffer.concat(chunks);
}

export async function loadVideoReview(input: LoadVideoReviewInput): Promise<
  ReturnType<typeof validateVideoReviewArtifact> & { readonly verifiedAgainstMainSha: string }
> {
  const { token, runId, runAttempt, fetchImpl = fetch } = input;
  if (typeof token !== 'string' || token.length === 0 || /\s/.test(token)
    || typeof runId !== 'string' || !/^[1-9][0-9]*$/.test(runId)
    || typeof runAttempt !== 'string' || !/^[1-9][0-9]*$/.test(runAttempt)) {
    throw new Error('Invalid video loader inputs');
  }
  const headers = {
    Authorization: `Bearer ${token}`,
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
  };
  async function fetchResponse(url: string, authenticated: boolean): Promise<Response> {
    try {
      return await fetchImpl(url, {
        redirect: 'manual',
        signal: AbortSignal.timeout(120_000),
        ...(authenticated ? { headers } : {}),
      });
    } catch {
      throw new Error('Video artifact request failed');
    }
  }
  async function json(apiPath: string): Promise<unknown> {
    const data = await responseBytes(await fetchResponse(`${ROOT}/${apiPath}`, true), 5_000_000);
    try {
      return JSON.parse(data.toString('utf8'));
    } catch {
      throw new Error('Invalid video API JSON');
    }
  }

  const runValue = await json(`actions/runs/${runId}/attempts/${runAttempt}`);
  const run = record(runValue);
  if (String(run?.['id']) !== runId || String(run?.['run_attempt']) !== runAttempt
    || typeof run?.['head_sha'] !== 'string' || !/^[a-f0-9]{40}$/.test(run['head_sha'])) {
    throw new Error('Video producer request mismatch');
  }
  const mainValue = await json('git/ref/heads/main');
  const main = record(mainValue);
  const mainObject = record(main?.['object']);
  if (main?.['ref'] !== 'refs/heads/main' || mainObject?.['type'] !== 'commit'
    || typeof mainObject['sha'] !== 'string' || !/^[a-f0-9]{40}$/.test(mainObject['sha'])) {
    throw new Error('Protected main reference unavailable');
  }
  const headSha = run['head_sha'];
  const mainSha = mainObject['sha'];
  const comparisonValue = await json(`compare/${headSha}...${mainSha}`);
  const comparison = record(comparisonValue);
  if (!['ahead', 'identical'].includes(String(comparison?.['status']))
    || record(comparison?.['base_commit'])?.['sha'] !== headSha
    || record(comparison?.['merge_base_commit'])?.['sha'] !== headSha) {
    throw new Error('Video producer is not on protected main ancestry');
  }
  const mainRevision = { ref: String(main['ref']), sha: headSha };
  const matches: unknown[] = [];
  const seen = new Set<number>();
  let complete = false;
  for (let page = 1; page <= 100; page += 1) {
    const result = record(await json(`actions/runs/${runId}/artifacts?per_page=100&page=${page}`));
    const artifacts = result?.['artifacts'];
    if (!Array.isArray(artifacts) || artifacts.length > 100) throw new Error('Invalid video artifact page');
    for (const itemValue of artifacts) {
      const item = record(itemValue);
      const id = item?.['id'];
      if (!Number.isSafeInteger(id) || typeof id !== 'number' || id <= 0 || seen.has(id)) {
        throw new Error('Unstable video artifact listing');
      }
      if (item === undefined) throw new Error('Unstable video artifact listing');
      seen.add(id);
      if (item['name'] === `production-onboarding-video-review-${runId}-${runAttempt}`) matches.push(itemValue);
    }
    if (artifacts.length < 100) {
      complete = true;
      break;
    }
  }
  if (!complete || matches.length !== 1) throw new Error('Unique saved video artifact unavailable');
  const listedArtifact = record(matches[0]);
  const listedArtifactId = listedArtifact?.['id'];
  if (!Number.isSafeInteger(listedArtifactId) || typeof listedArtifactId !== 'number') {
    throw new Error('Invalid video archive metadata');
  }
  const artifactValue = await json(`actions/artifacts/${listedArtifactId}`);
  const artifact = record(artifactValue);
  const size = artifact?.['size_in_bytes'];
  if (artifact?.['id'] !== listedArtifactId || !Number.isSafeInteger(size) || typeof size !== 'number'
    || size <= 0 || size > ARCHIVE_LIMIT) {
    throw new Error('Invalid video archive metadata');
  }
  validateVideoProducerMetadata({ run: runValue, artifact: artifactValue, mainRevision });
  const redirect = await fetchResponse(`${ROOT}/actions/artifacts/${listedArtifactId}/zip`, true);
  if (redirect.status !== 302) throw new Error('Video archive redirect unavailable');
  let signedUrl: URL;
  try {
    signedUrl = new URL(redirect.headers.get('location') ?? '');
  } catch {
    throw new Error('Invalid video archive redirect');
  }
  if (signedUrl.protocol !== 'https:' || signedUrl.username.length > 0 || signedUrl.password.length > 0) {
    throw new Error('Invalid video archive redirect');
  }
  // GitHub supplies the signed storage URL. Never forward the GitHub token and
  // never follow a second redirect to another endpoint.
  const archive = await responseBytes(await fetchResponse(signedUrl.href, false), ARCHIVE_LIMIT);
  const artifactDigest = artifact['digest'];
  if (typeof artifactDigest !== 'string'
    || `sha256:${createHash('sha256').update(archive).digest('hex')}` !== artifactDigest) {
    throw new Error('Video archive checksum mismatch');
  }
  const review = validateVideoReviewArtifact({
    json: extractVideoReviewJson(archive),
    run: runValue,
    artifact: artifactValue,
    mainRevision,
  });
  return { ...review, verifiedAgainstMainSha: mainSha };
}
