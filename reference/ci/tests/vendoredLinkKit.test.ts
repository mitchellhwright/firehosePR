import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';

import {
  createGithubPort,
  runLinkKitCheck,
  type LinkKitGithubPort,
} from '../src/actions/checkVendoredLinkKit.ts';
import {
  LINKKIT_ISSUE_LABELS,
  LINKKIT_ISSUE_MARKER,
  LINKKIT_ISSUE_TITLE,
  LINKKIT_PACKAGE_PATH,
  compareSemver,
  findTrackingIssue,
  newestStableRelease,
  parseLatestRelease,
  parseReleaseList,
  parseSemver,
  pinnedLinkKitVersion,
  planIssueAction,
  renderIssueBody,
  skippedReleases,
  stableRelease,
} from '../src/vendoredLinkKit.ts';

function packageSwift(version: string): string {
  return `        .binaryTarget(
            name: "LinkKit",
            url: "https://github.com/plaid/plaid-link-ios/releases/download/${version}/LinkKit.xcframework.zip",
            checksum: "abc"
        ),`;
}

function release(tag: string, overrides: Partial<Record<'draft' | 'prerelease', boolean>> = {}) {
  return {
    tag_name: tag,
    html_url: `https://github.com/plaid/plaid-link-ios/releases/tag/${tag}`,
    draft: overrides.draft ?? false,
    prerelease: overrides.prerelease ?? false,
  };
}

function stable(tag: string) {
  const parsed = stableRelease(release(tag));
  assert.ok(parsed);
  return parsed;
}

describe('pinned LinkKit version', () => {
  it('reads the version from the binaryTarget URL', () => {
    assert.equal(pinnedLinkKitVersion(packageSwift('7.0.4')).text, '7.0.4');
  });

  it('reads the committed Package.swift', () => {
    const version = pinnedLinkKitVersion(readFileSync(LINKKIT_PACKAGE_PATH, 'utf8'));
    assert.match(version.text, /^\d+\.\d+\.\d+$/);
  });

  it('fails loudly when no binaryTarget URL is present', () => {
    assert.throws(
      () => pinnedLinkKitVersion('.package(url: "https://github.com/plaid/plaid-link-ios", from: "7.0.0")'),
      /exactly one LinkKit binaryTarget URL.*found 0/,
    );
  });

  it('fails when two binaryTarget URLs are present', () => {
    assert.throws(() => pinnedLinkKitVersion(packageSwift('7.0.4') + packageSwift('7.1.0')), /found 2/);
  });

  it('fails when the pinned release is not semver', () => {
    assert.throws(() => pinnedLinkKitVersion(packageSwift('7.0')), /pins LinkKit release "7\.0"/);
    assert.throws(() => pinnedLinkKitVersion(packageSwift('7.0.4-beta.1')), /not MAJOR\.MINOR\.PATCH/);
  });
});

describe('semver comparison', () => {
  it('orders by major, then minor, then patch numerically', () => {
    assert.equal(compareSemver(parseSemver('7.0.4'), parseSemver('7.2.0')), -1);
    assert.equal(compareSemver(parseSemver('7.10.0'), parseSemver('7.9.9')), 1);
    assert.equal(compareSemver(parseSemver('8.0.0'), parseSemver('7.99.99')), 1);
    assert.equal(compareSemver(parseSemver('7.0.4'), parseSemver('7.0.5')), -1);
    assert.equal(compareSemver(parseSemver('7.2.0'), parseSemver('v7.2.0')), 0);
  });

  it('rejects malformed versions', () => {
    for (const text of ['7.2', '7.2.0.1', '07.2.0', 'latest', '']) {
      assert.throws(() => parseSemver(text), /not a MAJOR\.MINOR\.PATCH version/, text);
    }
  });
});

describe('release payloads', () => {
  it('rejects a latest-release payload that does not match the schema', () => {
    assert.throws(() => parseLatestRelease({ tag_name: '7.2.0' }), /unexpected .* latest-release payload: html_url/);
    assert.throws(() => parseLatestRelease({ ...release('7.2.0'), html_url: 'not a url' }), /html_url/);
    assert.throws(() => parseLatestRelease(null), /unexpected/);
  });

  it('ignores drafts, prereleases and non-semver tags', () => {
    assert.equal(stableRelease(release('7.3.0', { draft: true })), undefined);
    assert.equal(stableRelease(release('7.3.0', { prerelease: true })), undefined);
    assert.equal(stableRelease(release('7.3.0-beta.1')), undefined);
    assert.equal(stableRelease(release('7.2.0'))?.version.text, '7.2.0');
  });

  it('rejects a malformed release list instead of skipping entries', () => {
    assert.throws(() => parseReleaseList([release('7.2.0'), { tag_name: 7 }]), /release list/);
  });

  it('lists the stable releases after the pin up to the latest, oldest first', () => {
    const releases = parseReleaseList([
      release('7.2.0'), release('7.3.0'), release('7.1.0'), release('7.1.1', { prerelease: true }),
      release('7.0.4'), release('6.4.0'),
    ]);
    const skipped = skippedReleases(releases, parseSemver('7.0.4'), parseSemver('7.2.0'));
    assert.deepEqual(skipped.map((entry) => entry.version.text), ['7.1.0', '7.2.0']);
  });
});

describe('tracking issue lookup', () => {
  const body = `${LINKKIT_ISSUE_MARKER}\nbody`;

  it('matches the marker and skips pull requests and unmarked issues', () => {
    const found = findTrackingIssue([
      { number: 1, title: LINKKIT_ISSUE_TITLE, body, pull_request: { url: 'x' } },
      { number: 2, title: LINKKIT_ISSUE_TITLE, body: 'no marker' },
      { number: 3, title: LINKKIT_ISSUE_TITLE, body: null },
      { number: 4, title: LINKKIT_ISSUE_TITLE, body },
    ]);
    assert.deepEqual(found, { number: 4, body });
  });

  it('still owns the issue after a maintainer retitles it', () => {
    const found = findTrackingIssue([{ number: 9, title: 'Upgrade LinkKit to 7.2.0', body }]);
    assert.deepEqual(found, { number: 9, body });
  });

  it('finds nothing in an empty list and rejects a malformed one', () => {
    assert.equal(findTrackingIssue([]), undefined);
    assert.throws(() => findTrackingIssue({ message: 'Bad credentials' }), /unexpected issue list/);
  });
});

describe('issue decisions', () => {
  const pinned = parseSemver('7.0.4');
  const latest = stable('7.2.0');
  const skipped = [stable('7.1.0'), latest];
  const body = renderIssueBody(pinned, latest, skipped);

  it('creates the issue when behind and none is open', () => {
    assert.deepEqual(planIssueAction({ pinned, latest, skipped, openIssue: undefined }), { kind: 'create', body });
  });

  it('updates an open issue whose body is stale', () => {
    const action = planIssueAction({ pinned, latest, skipped, openIssue: { number: 9, body: 'old' } });
    assert.deepEqual(action, { kind: 'update', number: 9, body });
  });

  it('leaves an up-to-date open issue alone', () => {
    assert.equal(planIssueAction({ pinned, latest, skipped, openIssue: { number: 9, body } }).kind, 'none');
  });

  it('closes the open issue once the pin is current or ahead', () => {
    for (const version of ['7.2.0', '7.3.0']) {
      const action = planIssueAction({
        pinned: parseSemver(version), latest, skipped: [], openIssue: { number: 9, body },
      });
      assert.equal(action.kind, 'close', version);
    }
  });

  it('does nothing when current and no issue is open', () => {
    const action = planIssueAction({ pinned: parseSemver('7.2.0'), latest, skipped: [], openIssue: undefined });
    assert.equal(action.kind, 'none');
  });

  it('names both versions, each release-notes link and the checksum step', () => {
    assert.ok(body.startsWith(LINKKIT_ISSUE_MARKER));
    assert.match(body, /pins Plaid LinkKit \*\*7\.0\.4\*\*/);
    assert.match(body, /\[7\.2\.0\]\(https:\/\/github\.com\/plaid\/plaid-link-ios\/releases\/tag\/7\.2\.0\)/);
    assert.match(body, /- \[7\.1\.0\]/);
    assert.match(body, /swift package compute-checksum LinkKit\.xcframework\.zip/);
    assert.match(body, /releases\/download\/7\.2\.0\/LinkKit\.xcframework\.zip/);
  });

  it('keeps a v-prefixed tag in the archive URL', () => {
    const tagged = stable('v7.3.0');
    const taggedBody = renderIssueBody(parseSemver('7.0.4'), tagged, [tagged]);
    assert.match(taggedBody, /releases\/download\/v7\.3\.0\/LinkKit\.xcframework\.zip/);
    assert.doesNotMatch(taggedBody, /releases\/download\/7\.3\.0\//);
  });
});

describe('GitHub port', () => {
  it('reads every release page before choosing the newest stable version', async (context) => {
    const requested: string[] = [];
    context.mock.method(globalThis, 'fetch', async (input: string | URL | Request) => {
      const url = input instanceof Request ? input.url : String(input);
      requested.push(url);
      const page = new URL(url).searchParams.get('page');
      const body = page === '1'
        ? Array.from({ length: 100 }, (_, index) => release(`7.0.${index}`))
        : [release('8.0.0')];
      return new Response(JSON.stringify(body), { status: 200 });
    });
    const listed = await createGithubPort('https://api.github.com/', 'example-org/example-app', 'token').releases();
    assert.deepEqual(requested.map((url) => new URL(url).searchParams.get('page')), ['1', '2']);
    assert.equal(newestStableRelease(parseReleaseList(listed))?.version.text, '8.0.0');
  });

  it('finds the tracking issue by its author, not by labels a maintainer can remove', async (context) => {
    const requested: string[] = [];
    context.mock.method(globalThis, 'fetch', async (input: string | URL | Request) => {
      requested.push(input instanceof Request ? input.url : String(input));
      return new Response('[]', { status: 200 });
    });
    await createGithubPort('https://api.github.com/', 'example-org/example-app', 'token').openIssues();
    assert.equal(requested.length, 1);
    const url = new URL(requested[0] ?? '');
    assert.equal(url.pathname, '/repos/example-org/example-app/issues');
    assert.equal(url.searchParams.get('state'), 'open');
    assert.equal(url.searchParams.get('creator'), 'github-actions[bot]');
    assert.equal(url.searchParams.has('labels'), false);
  });

  it('finds the tracking issue on a later page after bot pull requests fill the first', async (context) => {
    const requested: string[] = [];
    context.mock.method(globalThis, 'fetch', async (input: string | URL | Request) => {
      const url = input instanceof Request ? input.url : String(input);
      requested.push(url);
      const page = new URL(url).searchParams.get('page');
      const body = page === '1'
        ? Array.from({ length: 100 }, (_, index) => ({
          number: index + 1, title: `Other PR ${index + 1}`, body: 'unrelated', pull_request: { url: 'x' },
        }))
        : [{ number: 101, title: LINKKIT_ISSUE_TITLE, body: `${LINKKIT_ISSUE_MARKER}\nbody` }];
      return new Response(JSON.stringify(body), { status: 200 });
    });
    const issues = await createGithubPort('https://api.github.com/', 'example-org/example-app', 'token').openIssues();
    assert.deepEqual(requested.map((url) => new URL(url).searchParams.get('page')), ['1', '2']);
    assert.deepEqual(findTrackingIssue(issues), { number: 101, body: `${LINKKIT_ISSUE_MARKER}\nbody` });
  });
});

interface FakeGithub extends LinkKitGithubPort {
  readonly writes: string[];
}

function fakeGithub(
  latest: unknown,
  issues: unknown[],
  releases: unknown[] = [release('7.2.0'), release('7.1.0'), release('7.0.4')],
): FakeGithub {
  const writes: string[] = [];
  return {
    writes,
    latestRelease: async () => latest,
    releases: async () => releases,
    openIssues: async () => issues,
    createIssue: async (title, _body, labels) => {
      writes.push(`create ${title} [${labels.join(',')}]`);
      return 42;
    },
    updateIssue: async (issueNumber) => {
      writes.push(`update #${issueNumber}`);
    },
    closeIssue: async (issueNumber) => {
      writes.push(`close #${issueNumber}`);
    },
  };
}

describe('LinkKit check run', () => {
  const log = () => undefined;

  it('opens the labelled tracking issue when behind', async () => {
    const github = fakeGithub(release('7.2.0'), []);
    const action = await runLinkKitCheck({ packageSwift: packageSwift('7.0.4'), github, dryRun: false, log });
    assert.equal(action.kind, 'create');
    assert.deepEqual(github.writes, [`create ${LINKKIT_ISSUE_TITLE} [${LINKKIT_ISSUE_LABELS.join(',')}]`]);
  });

  it('updates the open issue when a newer release appears', async () => {
    const github = fakeGithub(release('7.2.0'), [
      { number: 7, title: LINKKIT_ISSUE_TITLE, body: `${LINKKIT_ISSUE_MARKER}\nabout 7.1.0` },
    ]);
    await runLinkKitCheck({ packageSwift: packageSwift('7.0.4'), github, dryRun: false, log });
    assert.deepEqual(github.writes, ['update #7']);
  });

  it('closes the open issue when current', async () => {
    const github = fakeGithub(release('7.2.0'), [
      { number: 7, title: LINKKIT_ISSUE_TITLE, body: LINKKIT_ISSUE_MARKER },
    ]);
    await runLinkKitCheck({ packageSwift: packageSwift('7.2.0'), github, dryRun: false, log });
    assert.deepEqual(github.writes, ['close #7']);
  });

  it('is idempotent: a second run against its own issue writes nothing', async () => {
    const first = fakeGithub(release('7.2.0'), []);
    const created = await runLinkKitCheck({ packageSwift: packageSwift('7.0.4'), github: first, dryRun: false, log });
    assert.equal(created.kind, 'create');
    if (created.kind !== 'create') return;
    const second = fakeGithub(release('7.2.0'), [{ number: 42, title: LINKKIT_ISSUE_TITLE, body: created.body }]);
    const action = await runLinkKitCheck({ packageSwift: packageSwift('7.0.4'), github: second, dryRun: false, log });
    assert.equal(action.kind, 'none');
    assert.deepEqual(second.writes, []);
  });

  it('plans but never writes in a dry run', async () => {
    const messages: string[] = [];
    const github = fakeGithub(release('7.2.0'), []);
    const action = await runLinkKitCheck({
      packageSwift: packageSwift('7.0.4'), github, dryRun: true, log: (message) => messages.push(message),
    });
    assert.equal(action.kind, 'create');
    assert.deepEqual(github.writes, []);
    assert.ok(messages.includes('Dry run: would open a tracking issue.'));
  });

  it('leaves the issue unchanged when no release is stable', async () => {
    const prerelease = release('7.3.0', { prerelease: true });
    const github = fakeGithub(prerelease, [], [prerelease, release('7.2.0', { draft: true })]);
    const action = await runLinkKitCheck({ packageSwift: packageSwift('7.0.4'), github, dryRun: false, log });
    assert.equal(action.kind, 'none');
    assert.deepEqual(github.writes, []);
  });

  it('keeps the issue open when a backport is designated latest below a newer release', async () => {
    const github = fakeGithub(release('7.2.1'), [
      { number: 7, title: LINKKIT_ISSUE_TITLE, body: LINKKIT_ISSUE_MARKER },
    ], [release('7.2.1'), release('7.3.0'), release('7.2.0')]);
    const action = await runLinkKitCheck({ packageSwift: packageSwift('7.2.1'), github, dryRun: false, log });
    assert.equal(action.kind, 'update');
    assert.match(action.kind === 'update' ? action.body : '', /\[7\.3\.0\]/);
    assert.deepEqual(github.writes, ['update #7']);
  });

  it('fails before any write when the latest-release payload is malformed', async () => {
    const github = fakeGithub({ message: 'Not Found' }, []);
    await assert.rejects(
      runLinkKitCheck({ packageSwift: packageSwift('7.0.4'), github, dryRun: false, log }),
      /latest-release payload/,
    );
    assert.deepEqual(github.writes, []);
  });
});
