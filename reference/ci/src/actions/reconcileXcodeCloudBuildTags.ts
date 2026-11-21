#!/usr/bin/env node

import { createPrivateKey, sign } from 'node:crypto';
import { pathToFileURL } from 'node:url';

const APP_STORE_CONNECT_API = 'https://api.appstoreconnect.apple.com';
const APP_STORE_CONNECT_ACCEPT = 'application/vnd.api+json';
const DEFAULT_GITHUB_API = 'https://api.github.com';
const GITHUB_ACCEPT = 'application/vnd.github+json';
const MAIN_REF = 'refs/heads/main';
export const CHECKPOINT_TAG = 'xcode-cloud/reconciled-through';

type FetchImplementation = typeof fetch;

interface BuildRunResource {
  readonly id?: string;
  readonly type?: string;
  readonly attributes?: {
    readonly canonicalName?: string;
    readonly number?: number;
    readonly isPullRequestBuild?: boolean;
    readonly sourceCommit?: { readonly commitSha?: string };
    readonly executionProgress?: string;
    readonly completionStatus?: string;
  };
  readonly relationships?: {
    readonly sourceBranchOrTag?: { readonly data?: { readonly id?: string } };
  };
}

interface ApiObject {
  readonly id?: string;
  readonly type?: string;
  readonly sha?: string;
  readonly tag?: string;
  readonly message?: string;
  readonly status?: string;
  readonly object?: ApiObject;
}

interface ApiPayload extends ApiObject {
  readonly data?: BuildRunResource[];
  readonly included?: BuildRunResource[];
  readonly links?: { readonly next?: string | { readonly href?: string } | null };
  readonly errors?: readonly { readonly detail?: string }[];
}

interface XcodeBuild {
  readonly buildNumber: number;
  readonly commitSha: string | null;
  readonly executionProgress: string | null;
  readonly completionStatus: string | null;
}

interface SuccessfulXcodeBuild {
  readonly buildNumber: number;
  readonly commitSha: string;
}

interface Checkpoint {
  readonly exists: boolean;
  readonly refSha: string | null;
  readonly targetCommitSha: string | null;
  readonly throughBuildNumber: number;
}

interface RequestOptions {
  readonly token: string;
  readonly accept: string;
  readonly method?: string;
  readonly body?: Readonly<Record<string, unknown>>;
  readonly accepted?: readonly number[];
  readonly context?: string;
  readonly fetchImpl?: FetchImplementation;
}

type ServiceRequestOptions = Omit<RequestOptions, 'accept'>;

interface GitHubContext {
  readonly githubApi: string;
  readonly githubToken: string;
  readonly repository: string;
  readonly fetchImpl?: FetchImplementation;
}

interface ReconcileTagInput extends GitHubContext {
  readonly build: XcodeBuild;
}

interface RecoverableTagError extends Error {
  recoverableHistoricalTagWrite?: boolean;
}

function base64Url(value: string | Uint8Array): string {
  return Buffer.from(value)
    .toString('base64')
    .replaceAll('+', '-')
    .replaceAll('/', '_')
    .replace(/=+$/u, '');
}

export function normalizePrivateKey(value: string): string {
  const normalized = value.replaceAll('\\n', '\n').trim();
  if (normalized.includes('BEGIN PRIVATE KEY')) {
    return normalized;
  }
  return Buffer.from(normalized, 'base64').toString('utf8').trim();
}

export function createAppStoreConnectToken({ issuerId, keyId, privateKey, now = Date.now() }: {
  readonly issuerId: string;
  readonly keyId: string;
  readonly privateKey: string;
  readonly now?: number;
}): string {
  const issuedAt = Math.floor(now / 1000) - 20;
  const header = base64Url(JSON.stringify({ alg: 'ES256', kid: keyId, typ: 'JWT' }));
  const payload = base64Url(JSON.stringify({
    iss: issuerId,
    iat: issuedAt,
    exp: issuedAt + 1_200,
    aud: 'appstoreconnect-v1',
  }));
  const signingInput = `${header}.${payload}`;
  const signature = sign('sha256', Buffer.from(signingInput), {
    key: createPrivateKey(normalizePrivateKey(privateKey)),
    dsaEncoding: 'ieee-p1363',
  });
  return `${signingInput}.${base64Url(signature)}`;
}

export function tagNameForBuild(buildNumber: number): string {
  if (!Number.isSafeInteger(buildNumber) || buildNumber < 1) {
    throw new Error(`Invalid Xcode Cloud build number: ${buildNumber}`);
  }
  return `xcode-cloud/build-${buildNumber}`;
}

function isValidCommitSha(value: unknown): value is string {
  return typeof value === 'string' && /^[0-9a-f]{40}$/u.test(value);
}

function isTerminalBuild(build: XcodeBuild): boolean {
  return build.executionProgress === 'COMPLETE';
}

function isSuccessfulBuild(build: XcodeBuild): boolean {
  return isTerminalBuild(build) && build.completionStatus === 'SUCCEEDED';
}

export function selectRelevantMainBuilds(response: {
  readonly data?: readonly BuildRunResource[];
  readonly included?: readonly BuildRunResource[];
}): XcodeBuild[] {
  const references = new Map(
    (response.included ?? [])
      .filter((entry) => entry.type === 'scmGitReferences')
      .map((entry) => [entry.id, entry.attributes?.canonicalName])
  );

  return (response.data ?? [])
    .flatMap((run): XcodeBuild[] => {
      const attributes = run.attributes ?? {};
      const referenceId = run.relationships?.sourceBranchOrTag?.data?.id;
      const relevant = attributes.isPullRequestBuild === false
        && references.get(referenceId) === MAIN_REF
        && typeof attributes.number === 'number'
        && Number.isSafeInteger(attributes.number)
        && attributes.number > 0;
      return relevant ? [{
        buildNumber: attributes.number as number,
        commitSha: attributes.sourceCommit?.commitSha ?? null,
        executionProgress: attributes.executionProgress ?? null,
        completionStatus: attributes.completionStatus ?? null,
      }] : [];
    })
    .sort((left, right) => right.buildNumber - left.buildNumber);
}

export function selectSuccessfulMainBuilds(response: Parameters<typeof selectRelevantMainBuilds>[0]): SuccessfulXcodeBuild[] {
  return selectRelevantMainBuilds(response)
    .flatMap(build => isSuccessfulBuild(build) && isValidCommitSha(build.commitSha)
      ? [{ buildNumber: build.buildNumber, commitSha: build.commitSha }]
      : [])
    .sort((left, right) => left.buildNumber - right.buildNumber);
}

async function requestJson(url: string | URL, {
  token,
  accept,
  method = 'GET',
  body,
  accepted = [200],
  context,
  fetchImpl = fetch,
}: RequestOptions): Promise<{ readonly status: number; readonly payload: ApiPayload }> {
  const response = await fetchImpl(url, {
    method,
    headers: {
      Accept: accept,
      Authorization: `Bearer ${token}`,
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await response.text();
  const payload: ApiPayload = text ? JSON.parse(text) as ApiPayload : {};
  if (!accepted.includes(response.status)) {
    const message = payload?.errors?.[0]?.detail
      ?? payload?.message
      ?? `HTTP ${response.status}`;
    const requestId = response.headers?.get?.('x-github-request-id');
    const safeRequestId = typeof requestId === 'string' && /^[a-fA-F0-9:]{1,100}$/u.test(requestId)
      ? `; GitHub request ${requestId}` : '';
    const detail = context ? ` (${context}; HTTP ${response.status}${safeRequestId})` : '';
    throw new Error(`${method} ${url} failed: ${message}${detail}`);
  }
  return { status: response.status, payload };
}

function requestAppStoreConnectJson(url: string | URL, options: ServiceRequestOptions) {
  return requestJson(url, { ...options, accept: APP_STORE_CONNECT_ACCEPT });
}

function requestGitHubJson(url: string | URL, options: ServiceRequestOptions) {
  return requestJson(url, { ...options, accept: GITHUB_ACCEPT });
}

function checkpointRefUrl(githubApi: string, repository: string): string {
  return `${githubApi}/repos/${repository}/git/ref/tags/${encodeURIComponent(CHECKPOINT_TAG)}`;
}

function checkpointMessage(throughBuildNumber: number): string {
  if (!Number.isSafeInteger(throughBuildNumber) || throughBuildNumber < 0) {
    throw new Error(`Invalid Xcode Cloud checkpoint build number: ${throughBuildNumber}`);
  }
  return JSON.stringify({ version: 1, throughBuildNumber });
}

function parseCheckpointMessage(message: string): number {
  let value: unknown;
  try {
    value = JSON.parse(message);
  } catch {
    throw new Error(`${CHECKPOINT_TAG} annotation is not valid JSON.`);
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`${CHECKPOINT_TAG} annotation does not match the version 1 checkpoint contract.`);
  }
  const checkpoint = value as Readonly<Record<string, unknown>>;
  const throughBuildNumber = checkpoint['throughBuildNumber'];
  if (typeof throughBuildNumber !== 'number'
      || message !== checkpointMessage(throughBuildNumber)
      || checkpoint['version'] !== 1
      || Object.keys(checkpoint).length !== 2) {
    throw new Error(`${CHECKPOINT_TAG} annotation does not match the version 1 checkpoint contract.`);
  }
  return throughBuildNumber;
}

export async function readCheckpoint({
  githubApi,
  githubToken,
  repository,
  fetchImpl = fetch,
}: GitHubContext): Promise<Checkpoint> {
  const existing = await requestGitHubJson(checkpointRefUrl(githubApi, repository), {
    token: githubToken,
    accepted: [200, 404],
    fetchImpl,
  });
  if (existing.status === 404) {
    return {
      exists: false,
      refSha: null,
      targetCommitSha: null,
      throughBuildNumber: 0,
    };
  }

  const refObject = existing.payload?.object;
  if (refObject?.type !== 'tag' || !isValidCommitSha(refObject.sha)) {
    throw new Error(`${CHECKPOINT_TAG} must reference an annotated tag object.`);
  }
  const tagObjectUrl = `${githubApi}/repos/${repository}/git/tags/${refObject.sha}`;
  const { payload: tagObject } = await requestGitHubJson(tagObjectUrl, {
    token: githubToken,
    fetchImpl,
  });
  if (tagObject?.tag !== CHECKPOINT_TAG
      || tagObject.object?.type !== 'commit'
      || !isValidCommitSha(tagObject.object?.sha)
      || typeof tagObject.message !== 'string') {
    throw new Error(`${CHECKPOINT_TAG} annotated tag object is invalid.`);
  }

  return {
    exists: true,
    refSha: refObject.sha,
    targetCommitSha: tagObject.object.sha,
    throughBuildNumber: parseCheckpointMessage(tagObject.message),
  };
}

export async function resolveCiProductId({ appId, token, fetchImpl = fetch }: {
  readonly appId: string;
  readonly token: string;
  readonly fetchImpl?: FetchImplementation;
}): Promise<string> {
  const url = new URL('/v1/ciProducts', APP_STORE_CONNECT_API);
  // Apple rejects additional filters when filtering by the app relationship.
  url.searchParams.set('filter[app]', appId);
  url.searchParams.set('limit', '2');
  const { payload } = await requestAppStoreConnectJson(url, { token, fetchImpl });
  if (payload.data?.length !== 1 || typeof payload.data[0]?.id !== 'string') {
    throw new Error(`Expected one Xcode Cloud product for App Store app ${appId}, found ${payload.data?.length ?? 0}.`);
  }
  return payload.data[0].id;
}

function appStoreConnectPaginationUrl(
  value: string | { readonly href?: string },
  currentUrl: URL,
): URL {
  const link = typeof value === 'string' ? value : value?.href;
  if (typeof link !== 'string' || link.length === 0) {
    throw new Error('App Store Connect returned an invalid links.next value.');
  }

  let nextUrl;
  try {
    nextUrl = new URL(link, currentUrl);
  } catch {
    throw new Error('App Store Connect returned an invalid links.next URL.');
  }
  if (nextUrl.origin !== APP_STORE_CONNECT_API
      || nextUrl.username
      || nextUrl.password
      || nextUrl.hash) {
    throw new Error(`Refusing App Store Connect pagination URL outside ${APP_STORE_CONNECT_API}.`);
  }
  return nextUrl;
}

export async function listBuilds({
  productId,
  token,
  checkpointBuildNumber = 0,
  fetchImpl = fetch,
}: {
  readonly productId: string;
  readonly token: string;
  readonly checkpointBuildNumber?: number;
  readonly fetchImpl?: FetchImplementation;
}): Promise<XcodeBuild[]> {
  if (!Number.isSafeInteger(checkpointBuildNumber) || checkpointBuildNumber < 0) {
    throw new Error(`Invalid Xcode Cloud checkpoint build number: ${checkpointBuildNumber}`);
  }

  let pageUrl: URL | null = new URL(`/v1/ciProducts/${productId}/buildRuns`, APP_STORE_CONNECT_API);
  pageUrl.searchParams.set('fields[ciBuildRuns]', 'number,sourceCommit,isPullRequestBuild,executionProgress,completionStatus,sourceBranchOrTag');
  pageUrl.searchParams.set('fields[scmGitReferences]', 'name,canonicalName,kind');
  pageUrl.searchParams.set('include', 'sourceBranchOrTag');
  pageUrl.searchParams.set('limit', '50');
  pageUrl.searchParams.set('sort', '-number');

  const visitedPages = new Set<string>();
  const inventory: { data: BuildRunResource[]; included: BuildRunResource[] } = {
    data: [], included: [],
  };
  let previousBuildNumber = Number.POSITIVE_INFINITY;
  while (pageUrl) {
    const currentPageUrl: URL = pageUrl;
    const pageKey = currentPageUrl.href;
    if (visitedPages.has(pageKey)) {
      throw new Error(`App Store Connect pagination cycle detected at ${pageKey}.`);
    }
    visitedPages.add(pageKey);

    const { payload } = await requestAppStoreConnectJson(currentPageUrl, { token, fetchImpl });
    if (!Array.isArray(payload?.data)
        || (payload.included !== undefined && !Array.isArray(payload.included))) {
      throw new Error('App Store Connect returned an invalid build inventory page.');
    }

    const pageBuildNumbers: number[] = payload.data.map(run => run.attributes?.number)
      .filter((buildNumber): buildNumber is number => typeof buildNumber === 'number');
    if (pageBuildNumbers.length !== payload.data.length) {
      throw new Error('App Store Connect returned a build with an invalid build number.');
    }
    for (const buildNumber of pageBuildNumbers) {
      if (typeof buildNumber !== 'number' || !Number.isSafeInteger(buildNumber) || buildNumber < 1) {
        throw new Error('App Store Connect returned a build with an invalid build number.');
      }
      if (buildNumber >= previousBuildNumber) {
        throw new Error('App Store Connect build inventory was not strictly descending.');
      }
      previousBuildNumber = buildNumber;
    }
    inventory.data.push(...payload.data);
    inventory.included.push(...(payload.included ?? []));

    if (checkpointBuildNumber > 0
        && pageBuildNumbers.some((buildNumber) => buildNumber <= checkpointBuildNumber)) {
      break;
    }

    const next = payload.links?.next;
    pageUrl = next == null ? null : appStoreConnectPaginationUrl(next, currentPageUrl);
  }

  return selectRelevantMainBuilds(inventory);
}

export async function reconcileTag({
  build,
  githubApi,
  githubToken,
  repository,
  fetchImpl = fetch,
}: ReconcileTagInput): Promise<'existing' | 'created'> {
  if (!isValidCommitSha(build.commitSha)) {
    throw new Error(`Xcode Cloud build ${build.buildNumber} has an invalid source commit.`);
  }
  const tagName = tagNameForBuild(build.buildNumber);
  const encodedTag = encodeURIComponent(tagName);
  const refUrl = `${githubApi}/repos/${repository}/git/ref/tags/${encodedTag}`;
  const existing = await requestGitHubJson(refUrl, {
    token: githubToken,
    accepted: [200, 404],
    fetchImpl,
  });
  if (existing.status === 200) {
    const object = existing.payload.object;
    if (object?.type !== 'commit' || object.sha !== build.commitSha) {
      throw new Error(`${tagName} already exists but does not point directly to ${build.commitSha}.`);
    }
    console.log(`${tagName} already tracks ${build.commitSha}.`);
    return 'existing';
  }

  const compareUrl = `${githubApi}/repos/${repository}/compare/${build.commitSha}...main`;
  const comparison = await requestGitHubJson(compareUrl, {
    token: githubToken,
    fetchImpl,
  });
  if (typeof comparison.payload.status !== 'string'
      || !['ahead', 'identical'].includes(comparison.payload.status)) {
    throw new Error(`Refusing to tag ${build.commitSha}: it is not reachable from main.`);
  }

  try {
    await requestGitHubJson(`${githubApi}/repos/${repository}/git/refs`, {
      token: githubToken,
      method: 'POST',
      accepted: [201],
      fetchImpl,
      context: `create ${tagName} at ${build.commitSha}`,
      body: {
        ref: `refs/tags/${tagName}`,
        sha: build.commitSha,
      },
    });
  } catch (error: unknown) {
    if (!(error instanceof Error)) throw error;
    (error as RecoverableTagError).recoverableHistoricalTagWrite = true;
    throw error;
  }
  console.log(`Created ${tagName} at ${build.commitSha}.`);
  return 'created';
}

export async function reconcileBuildTags({
  builds,
  checkpointBuildNumber = 0,
  requiredCommitSha = null,
  githubApi,
  githubToken,
  repository,
  fetchImpl = fetch,
  reconcileTagImpl = reconcileTag,
}: GitHubContext & {
  readonly builds: readonly XcodeBuild[];
  readonly checkpointBuildNumber?: number;
  readonly requiredCommitSha?: string | null;
  readonly reconcileTagImpl?: (input: ReconcileTagInput) => Promise<unknown>;
}): Promise<number> {
  if (!Number.isSafeInteger(checkpointBuildNumber) || checkpointBuildNumber < 0) {
    throw new Error(`Invalid Xcode Cloud checkpoint build number: ${checkpointBuildNumber}`);
  }

  const seenBuildNumbers = new Set<number>();
  const aboveCheckpoint = [...builds]
    .filter((build) => build.buildNumber > checkpointBuildNumber)
    .sort((left, right) => right.buildNumber - left.buildNumber);
  for (const build of aboveCheckpoint) {
    if (!Number.isSafeInteger(build.buildNumber) || build.buildNumber < 1) {
      throw new Error(`Invalid Xcode Cloud build number: ${build.buildNumber}`);
    }
    if (seenBuildNumbers.has(build.buildNumber)) {
      throw new Error(`Duplicate Xcode Cloud build number: ${build.buildNumber}`);
    }
    seenBuildNumbers.add(build.buildNumber);
  }

  let lowestUnresolvedBuildNumber = Number.POSITIVE_INFINITY;
  for (const build of aboveCheckpoint.filter(isSuccessfulBuild)) {
    if (!isValidCommitSha(build.commitSha)) {
      throw new Error(`Successful Xcode Cloud build ${build.buildNumber} has an invalid source commit.`);
    }
    try {
      await reconcileTagImpl({
        build,
        githubApi,
        githubToken,
        repository,
        fetchImpl,
      });
    } catch (error: unknown) {
      const historicalWriteFailure = error instanceof Error
        && (error as RecoverableTagError).recoverableHistoricalTagWrite === true
        && isValidCommitSha(requiredCommitSha)
        && build.commitSha !== requiredCommitSha;
      if (!historicalWriteFailure) throw error;
      lowestUnresolvedBuildNumber = Math.min(lowestUnresolvedBuildNumber, build.buildNumber);
      const message = error instanceof Error ? error.message : String(error);
      console.warn(`::warning::Unresolved historical Xcode Cloud tag for build ${build.buildNumber}: ${message}`);
    }
  }

  if (aboveCheckpoint.length === 0) {
    return checkpointBuildNumber;
  }
  const lowestNonterminal = aboveCheckpoint
    .filter((build) => !isTerminalBuild(build))
    .reduce(
      (lowest, build) => Math.min(lowest, build.buildNumber),
      Number.POSITIVE_INFINITY
    );
  let throughBuildNumber = Math.max(
    checkpointBuildNumber,
    ...aboveCheckpoint.map((build) => build.buildNumber)
  );
  if (Number.isFinite(lowestNonterminal)) {
    throughBuildNumber = Math.min(throughBuildNumber, lowestNonterminal - 1);
  }
  if (Number.isFinite(lowestUnresolvedBuildNumber)) {
    throughBuildNumber = Math.min(throughBuildNumber, lowestUnresolvedBuildNumber - 1);
  }
  return Math.max(checkpointBuildNumber, throughBuildNumber);
}

export async function readMainCommitSha(
  { githubApi, githubToken, repository, fetchImpl = fetch }: GitHubContext,
): Promise<string> {
  const { payload } = await requestGitHubJson(
    `${githubApi}/repos/${repository}/git/ref/heads/main`,
    { token: githubToken, fetchImpl }
  );
  if (payload?.object?.type !== 'commit' || !isValidCommitSha(payload.object.sha)) {
    throw new Error('refs/heads/main does not point directly to a commit.');
  }
  return payload.object.sha;
}

export async function publishCheckpoint({
  expectedCheckpoint,
  throughBuildNumber,
  githubApi,
  githubToken,
  repository,
  fetchImpl = fetch,
  readCheckpointImpl = readCheckpoint,
}: GitHubContext & {
  readonly expectedCheckpoint: Checkpoint;
  readonly throughBuildNumber: number;
  readonly readCheckpointImpl?: (input: GitHubContext) => Promise<Checkpoint>;
}): Promise<boolean> {
  if (throughBuildNumber <= expectedCheckpoint.throughBuildNumber) {
    return false;
  }

  const currentCheckpoint = await readCheckpointImpl({
    githubApi,
    githubToken,
    repository,
    fetchImpl,
  });
  if (currentCheckpoint.exists !== expectedCheckpoint.exists
      || currentCheckpoint.refSha !== expectedCheckpoint.refSha) {
    throw new Error(`${CHECKPOINT_TAG} changed during reconciliation; refusing to publish a stale checkpoint.`);
  }

  const mainRefUrl = `${githubApi}/repos/${repository}/git/ref/heads/main`;
  const { payload: mainRef } = await requestGitHubJson(mainRefUrl, {
    token: githubToken,
    fetchImpl,
  });
  if (mainRef.object?.type !== 'commit' || !isValidCommitSha(mainRef.object.sha)) {
    throw new Error('refs/heads/main does not point directly to a commit.');
  }

  const { payload: tagObject } = await requestGitHubJson(
    `${githubApi}/repos/${repository}/git/tags`,
    {
      token: githubToken,
      method: 'POST',
      accepted: [201],
      fetchImpl,
      body: {
        tag: CHECKPOINT_TAG,
        message: checkpointMessage(throughBuildNumber),
        object: mainRef.object.sha,
        type: 'commit',
      },
    }
  );
  if (!isValidCommitSha(tagObject?.sha)) {
    throw new Error('GitHub returned an invalid annotated checkpoint tag object.');
  }

  if (expectedCheckpoint.exists) {
    await requestGitHubJson(
      `${githubApi}/repos/${repository}/git/refs/tags/${encodeURIComponent(CHECKPOINT_TAG)}`,
      {
        token: githubToken,
        method: 'PATCH',
        fetchImpl,
        context: `advance ${CHECKPOINT_TAG} through build ${throughBuildNumber}`,
        body: { sha: tagObject.sha, force: true },
      }
    );
  } else {
    await requestGitHubJson(`${githubApi}/repos/${repository}/git/refs`, {
      token: githubToken,
      method: 'POST',
      accepted: [201],
      fetchImpl,
      context: `create ${CHECKPOINT_TAG} through build ${throughBuildNumber} at ${mainRef.object.sha}`,
      body: {
        ref: `refs/tags/${CHECKPOINT_TAG}`,
        sha: tagObject.sha,
      },
    });
  }
  console.log(`Published ${CHECKPOINT_TAG} through Xcode Cloud build ${throughBuildNumber}.`);
  return true;
}

export async function reconcileAndPublishBuildTags({
  builds,
  checkpoint,
  githubApi,
  githubToken,
  repository,
  requiredCommitSha = null,
  fetchImpl = fetch,
  reconcileTagImpl = reconcileTag,
  publishCheckpointImpl = publishCheckpoint,
}: GitHubContext & {
  readonly builds: readonly XcodeBuild[];
  readonly checkpoint: Checkpoint;
  readonly requiredCommitSha?: string | null;
  readonly reconcileTagImpl?: (input: ReconcileTagInput) => Promise<unknown>;
  readonly publishCheckpointImpl?: (input: GitHubContext & {
    readonly expectedCheckpoint: Checkpoint;
    readonly throughBuildNumber: number;
  }) => Promise<unknown>;
}): Promise<number> {
  const throughBuildNumber = await reconcileBuildTags({
    builds,
    checkpointBuildNumber: checkpoint.throughBuildNumber,
    requiredCommitSha,
    githubApi,
    githubToken,
    repository,
    fetchImpl,
    reconcileTagImpl,
  });
  if (throughBuildNumber > checkpoint.throughBuildNumber) {
    await publishCheckpointImpl({
      expectedCheckpoint: checkpoint,
      throughBuildNumber,
      githubApi,
      githubToken,
      repository,
      fetchImpl,
    });
  }
  return throughBuildNumber;
}

function requiredEnvironment(name: string): string {
  const value = process.env[name];
  if (value === undefined || value.length === 0) throw new Error(`${name} is required`);
  return value;
}

export async function main(): Promise<void> {
  const required = [
    'APP_STORE_CONNECT_API_KEY_ID',
    'APP_STORE_CONNECT_API_KEY_ISSUER_ID',
    'APP_STORE_CONNECT_API_KEY_CONTENT',
    'APP_STORE_CONNECT_APP_ID',
    'GH_TOKEN',
    'REPOSITORY',
  ];
  const missing = required.filter((name) => !process.env[name]);
  if (missing.length > 0) {
    throw new Error(`Missing required environment variables: ${missing.join(', ')}`);
  }

  const appStoreToken = createAppStoreConnectToken({
    issuerId: requiredEnvironment('APP_STORE_CONNECT_API_KEY_ISSUER_ID'),
    keyId: requiredEnvironment('APP_STORE_CONNECT_API_KEY_ID'),
    privateKey: requiredEnvironment('APP_STORE_CONNECT_API_KEY_CONTENT'),
  });
  const githubApi = process.env.GITHUB_API_URL || DEFAULT_GITHUB_API;
  const requiredCommitSha = await readMainCommitSha({
    githubApi,
    githubToken: requiredEnvironment('GH_TOKEN'),
    repository: requiredEnvironment('REPOSITORY'),
  });
  const checkpoint = await readCheckpoint({
    githubApi,
    githubToken: requiredEnvironment('GH_TOKEN'),
    repository: requiredEnvironment('REPOSITORY'),
  });
  const productId = await resolveCiProductId({
    appId: requiredEnvironment('APP_STORE_CONNECT_APP_ID'),
    token: appStoreToken,
  });
  const builds = await listBuilds({
    productId,
    token: appStoreToken,
    checkpointBuildNumber: checkpoint.throughBuildNumber,
  });
  await reconcileAndPublishBuildTags({
    builds,
    checkpoint,
    githubApi,
    githubToken: requiredEnvironment('GH_TOKEN'),
    repository: requiredEnvironment('REPOSITORY'),
    requiredCommitSha,
  });
  if (builds.length === 0) {
    console.log('No relevant Xcode Cloud main builds were returned.');
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
