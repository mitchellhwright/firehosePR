import { z } from 'zod';

/**
 * Plaid LinkKit is vendored as a SwiftPM `binaryTarget` whose URL names the
 * release. Dependabot cannot update a binaryTarget URL, so this module holds
 * the pure half of the weekly check that compares the pinned release with
 * Plaid's latest one and keeps a single tracking issue in step with it.
 */

export const LINKKIT_PACKAGE_PATH = 'ios/Packages/PlaidLink/Package.swift';
export const LINKKIT_RELEASES_REPOSITORY = 'plaid/plaid-link-ios';
export const LINKKIT_ISSUE_TITLE = "LinkKit is behind Plaid's latest release";
export const LINKKIT_ISSUE_MARKER = '<!-- vendored-linkkit-version-check -->';
export const LINKKIT_ISSUE_LABELS = ['dependencies', 'ios'] as const;
/** The account `GITHUB_TOKEN` writes as; it authors the tracking issue. */
export const LINKKIT_ISSUE_CREATOR = 'github-actions[bot]';

const BINARY_TARGET_URL =
  /https:\/\/github\.com\/plaid\/plaid-link-ios\/releases\/download\/([^/"\s]+)\/LinkKit\.xcframework\.zip/g;
const SEMVER = /^v?(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;

export interface Semver {
  readonly major: number;
  readonly minor: number;
  readonly patch: number;
  readonly text: string;
}

/** Parses a plain `MAJOR.MINOR.PATCH` release tag; anything else is an error. */
export function parseSemver(text: string): Semver {
  const match = SEMVER.exec(text);
  if (match === null) {
    throw new Error(`"${text}" is not a MAJOR.MINOR.PATCH version`);
  }
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    text: text.replace(/^v/, ''),
  };
}

export function compareSemver(left: Semver, right: Semver): -1 | 0 | 1 {
  const pairs = [
    [left.major, right.major],
    [left.minor, right.minor],
    [left.patch, right.patch],
  ] as const;
  for (const [a, b] of pairs) {
    if (a < b) return -1;
    if (a > b) return 1;
  }
  return 0;
}

/** The LinkKit version the binaryTarget URL in Package.swift pins. */
export function pinnedLinkKitVersion(packageSwift: string): Semver {
  const versions = [...packageSwift.matchAll(BINARY_TARGET_URL)].map((match) => match[1] ?? '');
  if (versions.length !== 1) {
    throw new Error(
      `${LINKKIT_PACKAGE_PATH} must contain exactly one LinkKit binaryTarget URL of the form `
      + `https://github.com/plaid/plaid-link-ios/releases/download/<version>/LinkKit.xcframework.zip; `
      + `found ${versions.length}. Update ci/src/vendoredLinkKit.ts if the vendoring changed.`,
    );
  }
  const [version = ''] = versions;
  try {
    return parseSemver(version);
  } catch (error) {
    throw new Error(
      `${LINKKIT_PACKAGE_PATH} pins LinkKit release "${version}", which is not MAJOR.MINOR.PATCH`,
      { cause: error },
    );
  }
}

const releaseSchema = z.object({
  tag_name: z.string().min(1),
  html_url: z.url(),
  draft: z.boolean(),
  prerelease: z.boolean(),
});

export type Release = z.infer<typeof releaseSchema>;

export interface StableRelease {
  readonly version: Semver;
  /** The release tag exactly as published; asset download paths use it, `v` prefix included. */
  readonly tag: string;
  readonly url: string;
}

/** Validates the `releases/latest` payload; throws with the schema issues when it does not match. */
export function parseLatestRelease(payload: unknown): Release {
  const result = releaseSchema.safeParse(payload);
  if (!result.success) {
    throw new Error(
      `GitHub returned an unexpected ${LINKKIT_RELEASES_REPOSITORY} latest-release payload: `
      + result.error.issues.map((issue) => `${issue.path.join('.') || 'value'} ${issue.message}`).join('; '),
    );
  }
  return result.data;
}

/** A published, non-prerelease release with a semver tag, or `undefined` for anything else. */
export function stableRelease(release: Release): StableRelease | undefined {
  if (release.draft || release.prerelease || !SEMVER.test(release.tag_name)) return undefined;
  return { version: parseSemver(release.tag_name), tag: release.tag_name, url: release.html_url };
}

/** Every stable release in the list payload; malformed entries are rejected, not skipped. */
export function parseReleaseList(payload: unknown): readonly StableRelease[] {
  const result = z.array(releaseSchema).safeParse(payload);
  if (!result.success) {
    throw new Error(
      `GitHub returned an unexpected ${LINKKIT_RELEASES_REPOSITORY} release list: `
      + result.error.issues.map((issue) => `${issue.path.join('.') || 'value'} ${issue.message}`).join('; '),
    );
  }
  return result.data.flatMap((release) => stableRelease(release) ?? []);
}

/**
 * The highest stable version among `releases`. GitHub's `releases/latest`
 * follows designation and chronology, so a backport marked latest can sit
 * below a newer release; the version comparison decides instead.
 */
export function newestStableRelease(releases: readonly StableRelease[]): StableRelease | undefined {
  let newest: StableRelease | undefined;
  for (const release of releases) {
    if (newest === undefined || compareSemver(release.version, newest.version) > 0) newest = release;
  }
  return newest;
}

/** The stable releases after `pinned` up to and including `latest`, oldest first. */
export function skippedReleases(
  releases: readonly StableRelease[],
  pinned: Semver,
  latest: Semver,
): readonly StableRelease[] {
  return releases
    .filter((release) => compareSemver(release.version, pinned) > 0
      && compareSemver(release.version, latest) <= 0)
    .sort((left, right) => compareSemver(left.version, right.version));
}

export function renderIssueBody(
  pinned: Semver,
  latest: StableRelease,
  skipped: readonly StableRelease[],
): string {
  const notes = skipped.length > 0 ? skipped : [latest];
  const zipUrl = `https://github.com/${LINKKIT_RELEASES_REPOSITORY}/releases/download/`
    + `${latest.tag}/LinkKit.xcframework.zip`;
  return [
    LINKKIT_ISSUE_MARKER,
    `\`${LINKKIT_PACKAGE_PATH}\` pins Plaid LinkKit **${pinned.text}**; `
    + `Plaid's latest release is **[${latest.version.text}](${latest.url})**.`,
    '',
    'Dependabot cannot update a SwiftPM `binaryTarget` URL, so the weekly '
    + '`Vendored LinkKit version check` workflow opens and updates this issue.',
    '',
    '## Release notes',
    '',
    ...notes.map((release) => `- [${release.version.text}](${release.url})`),
    '',
    '## Upgrade steps',
    '',
    '1. Download the release archive and compute its checksum:',
    '   ```sh',
    `   curl -fsSLo LinkKit.xcframework.zip ${zipUrl}`,
    '   swift package compute-checksum LinkKit.xcframework.zip',
    '   ```',
    `2. In \`${LINKKIT_PACKAGE_PATH}\`, change the \`binaryTarget\` \`url\` to \`${zipUrl}\` `
    + 'and set `checksum` to the value printed above.',
    '3. Build and test the iOS app, reading the release notes above for breaking changes.',
    '',
    'This issue closes itself on the first weekly run after the pinned version reaches the latest release.',
  ].join('\n');
}

export interface TrackingIssue {
  readonly number: number;
  readonly body: string;
}

const issueSchema = z.object({
  number: z.number().int().positive(),
  body: z.string().nullable(),
  pull_request: z.unknown().optional(),
});

/**
 * The open tracking issue in an issue-list payload, identified by its hidden marker so a
 * maintainer's retitle keeps it owned; never a pull request.
 */
export function findTrackingIssue(payload: unknown): TrackingIssue | undefined {
  const result = z.array(issueSchema).safeParse(payload);
  if (!result.success) {
    throw new Error(`GitHub returned an unexpected issue list: ${result.error.message}`);
  }
  const match = result.data.find((issue) => issue.pull_request === undefined
    && (issue.body ?? '').includes(LINKKIT_ISSUE_MARKER));
  return match === undefined ? undefined : { number: match.number, body: match.body ?? '' };
}

export type IssueAction =
  | { readonly kind: 'create'; readonly body: string }
  | { readonly kind: 'update'; readonly number: number; readonly body: string }
  | { readonly kind: 'close'; readonly number: number; readonly comment: string }
  | { readonly kind: 'none'; readonly reason: string };

export interface IssuePlanInput {
  readonly pinned: Semver;
  readonly latest: StableRelease;
  readonly skipped: readonly StableRelease[];
  readonly openIssue: TrackingIssue | undefined;
}

/** What to do with the tracking issue. Behind opens or refreshes it; current or ahead closes it. */
export function planIssueAction(input: IssuePlanInput): IssueAction {
  const { pinned, latest, skipped, openIssue } = input;
  if (compareSemver(pinned, latest.version) >= 0) {
    if (openIssue === undefined) {
      return { kind: 'none', reason: `LinkKit ${pinned.text} is current (latest ${latest.version.text})` };
    }
    return {
      kind: 'close',
      number: openIssue.number,
      comment: `\`${LINKKIT_PACKAGE_PATH}\` now pins LinkKit ${pinned.text}, `
        + `which is at or past Plaid's latest release ${latest.version.text}. Closing.`,
    };
  }
  const body = renderIssueBody(pinned, latest, skipped);
  if (openIssue === undefined) return { kind: 'create', body };
  if (openIssue.body === body) {
    return { kind: 'none', reason: `issue #${openIssue.number} already describes LinkKit ${latest.version.text}` };
  }
  return { kind: 'update', number: openIssue.number, body };
}
