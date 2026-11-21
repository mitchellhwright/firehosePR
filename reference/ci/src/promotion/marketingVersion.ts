import { z } from 'zod';

export const marketingVersionProjectPath = 'ios/example-ios.xcodeproj/project.pbxproj';
export const marketingVersionCommitPrefix = 'chore(ios): set promotion marketing version to ';
const appleApi = 'https://api.appstoreconnect.apple.com';
const versionPattern = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/u;
const appleVersionPattern = /^(0|[1-9]\d*)\.(0|[1-9]\d*)(?:\.(0|[1-9]\d*))?$/u;
const settingPattern = /(^[ \t]*MARKETING_VERSION = )(\d+\.\d+\.\d+)(;[ \t]*$)/gmu;
const expectedSettingCount = 16;
const approvedStates = new Set([
  'ACCEPTED', 'PENDING_APPLE_RELEASE', 'PENDING_DEVELOPER_RELEASE',
  'READY_FOR_DISTRIBUTION', 'REPLACED_WITH_NEW_VERSION',
]);
const unavailableStates = new Set([
  'DEVELOPER_REJECTED', 'INVALID_BINARY', 'METADATA_REJECTED', 'REJECTED',
]);

const versionResource = z.object({
  attributes: z.object({
    platform: z.string(),
    versionString: z.string(),
    appVersionState: z.string(),
  }),
});
const versionPage = z.object({
  data: z.array(versionResource),
  links: z.object({ next: z.string().nullish() }).optional(),
});

type Version = readonly [major: number, minor: number, patch: number];

function parseVersion(value: string): Version {
  const match = appleVersionPattern.exec(value);
  if (match === null) throw new Error(`Expected a numeric iOS marketing version, got ${value}.`);
  const parts = [Number(match[1]), Number(match[2]), Number(match[3] ?? 0)] as const;
  if (parts.some((part) => !Number.isSafeInteger(part))) {
    throw new Error(`iOS marketing version is outside the supported integer range: ${value}.`);
  }
  return parts;
}

function compareVersions(left: Version, right: Version): number {
  for (let index = 0; index < 3; index += 1) {
    const difference = (left[index] ?? 0) - (right[index] ?? 0);
    if (difference !== 0) return difference;
  }
  return 0;
}

export function marketingVersionExceeds(version: string, previous: string): boolean {
  return compareVersions(parseVersion(version), parseVersion(previous)) > 0;
}

export function readMarketingVersion(source: string): string {
  const versions = [...source.matchAll(settingPattern)].map((match) => match[2]);
  if (versions.length !== expectedSettingCount || versions.some((version) => version !== versions[0])) {
    throw new Error(`Expected ${expectedSettingCount} identical MARKETING_VERSION settings in ${marketingVersionProjectPath}; found ${versions.length}.`);
  }
  const version = versions[0];
  if (version === undefined) throw new Error('Missing MARKETING_VERSION setting.');
  parseVersion(version);
  return version;
}

export function rewriteMarketingVersion(source: string, nextVersion: string): string {
  if (!versionPattern.test(nextVersion)) throw new Error('Promotion marketing version must have three numeric parts.');
  parseVersion(nextVersion);
  const current = readMarketingVersion(source);
  if (compareVersions(parseVersion(nextVersion), parseVersion(current)) <= 0) {
    throw new Error(`Promotion marketing version ${nextVersion} must exceed source version ${current}.`);
  }
  const rewritten = source.replace(settingPattern, (_line, before: string, _old: string, after: string) =>
    `${before}${nextVersion}${after}`);
  if (readMarketingVersion(rewritten) !== nextVersion || rewritten === source) {
    throw new Error('Could not rewrite all iOS marketing version settings.');
  }
  return rewritten;
}

export function nextPromotionVersion(sourceVersion: string, versions: readonly {
  readonly platform: string;
  readonly versionString: string;
  readonly appVersionState: string;
}[], reservedVersions: readonly string[] = []): string {
  const source = parseVersion(sourceVersion);
  let highest = source;
  let highestApproved: Version | null = null;
  let highestReserved: Version | null = null;
  for (const version of versions) {
    if (version.platform !== 'IOS' || unavailableStates.has(version.appVersionState)) continue;
    const parsed = parseVersion(version.versionString);
    if (approvedStates.has(version.appVersionState)
      && (highestApproved === null || compareVersions(parsed, highestApproved) > 0)) {
      highestApproved = parsed;
    }
    if (compareVersions(parsed, highest) > 0) highest = parsed;
  }
  for (const version of reservedVersions) {
    const parsed = parseVersion(version);
    if (highestReserved === null || compareVersions(parsed, highestReserved) > 0) highestReserved = parsed;
    if (compareVersions(parsed, highest) > 0) highest = parsed;
  }
  if (highestApproved === null) throw new Error('App Store Connect returned no approved iOS version; refusing to guess the promotion version.');
  if (compareVersions(source, highestApproved) > 0 && compareVersions(source, highest) >= 0
    && (highestReserved === null || compareVersions(source, highestReserved) > 0)) {
    return sourceVersion;
  }
  if (highest[2] === Number.MAX_SAFE_INTEGER) throw new Error('iOS marketing version patch overflow.');
  return `${highest[0]}.${highest[1]}.${highest[2] + 1}`;
}

/** Read every page before choosing: Apple does not promise semantic version ordering. */
export async function readAppleVersions(appId: string, token: string, fetchImpl: typeof fetch = fetch): Promise<{
  readonly platform: string;
  readonly versionString: string;
  readonly appVersionState: string;
}[]> {
  if (!/^\d+$/u.test(appId)) throw new Error('APP_STORE_CONNECT_APP_ID must be numeric.');
  const first = new URL(`/v1/apps/${appId}/appStoreVersions`, appleApi);
  first.searchParams.set('filter[platform]', 'IOS');
  first.searchParams.set('fields[appStoreVersions]', 'platform,versionString,appVersionState');
  first.searchParams.set('limit', '200');
  const versions: { platform: string; versionString: string; appVersionState: string }[] = [];
  const visited = new Set<string>();
  let next: URL | null = first;
  while (next !== null) {
    if (visited.size >= 20 || visited.has(next.href)) throw new Error('App Store Connect version pagination did not terminate.');
    if (next.origin !== appleApi || !next.pathname.startsWith(`/v1/apps/${appId}/appStoreVersions`)) {
      throw new Error('Refusing an App Store Connect version pagination URL outside this app.');
    }
    visited.add(next.href);
    const response = await fetchImpl(next, {
      headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.api+json' },
    });
    if (!response.ok) throw new Error(`Could not read App Store Connect versions: HTTP ${response.status}.`);
    const page = versionPage.parse(await response.json());
    versions.push(...page.data.map((resource) => resource.attributes));
    next = page.links?.next ? new URL(page.links.next, appleApi) : null;
  }
  return versions;
}

export function versionFromCommitMessage(message: string): string | null {
  if (!message.startsWith(marketingVersionCommitPrefix)) return null;
  const version = message.slice(marketingVersionCommitPrefix.length);
  return versionPattern.test(version) ? version : null;
}
