import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import test from 'node:test';

import { derivePrValidationPlan } from '../src/prValidationPlan.ts';

// This repository deliberately does not use CODEOWNERS or path-based automatic
// review requests. GitHub honours a CODEOWNERS file in exactly three locations,
// so all three must stay absent: a file reappearing in any of them silently
// changes who is auto-requested on every pull request.
//
// `.github/CODEOWNERS` was added and deleted again within one day in September
// 2026, and the deletion was later re-read as accidental collateral precisely
// because only prose recorded the decision. This guard is that record, in code.
const codeownersLocations = ['CODEOWNERS', '.github/CODEOWNERS', 'docs/CODEOWNERS'] as const;

const securityDocPath = 'docs/github-repository-security.md';

const repositoryFile = (path: string): URL => new URL(`../../${path}`, import.meta.url);

// Line wrapping in the document is not part of the decision; compare on text.
function readSecurityDoc(): string {
  try {
    return readFileSync(repositoryFile(securityDocPath), 'utf8').replace(/\s+/g, ' ').trim();
  } catch (cause) {
    // Renaming or deleting the document is itself a way to drop the decision,
    // and it is the case where a reader most needs the pointer. Read lazily and
    // rethrow with the explanation rather than failing the whole file at import.
    throw new Error(
      `${securityDocPath} must exist and keep stating the review-ownership decision. `
        + 'The repository intentionally does not use CODEOWNERS; that decision lives in this '
        + 'document and is enforced by this guard. Moving it means updating both together.',
      { cause },
    );
  }
}

test('no CODEOWNERS file exists in any location GitHub reads', () => {
  for (const location of codeownersLocations) {
    assert.equal(
      existsSync(repositoryFile(location)),
      false,
      `${location} must not exist. See the "Review ownership" section of ${securityDocPath}. `
        + 'Reversing that decision is a product-owner call rather than a side effect of a pull '
        + 'request: change the document and this guard together, in a change that says so.',
    );
  }
});

test('the review-ownership decision stays documented', () => {
  // Pinned as exact substrings after whitespace normalisation, so a benign
  // reword of one of these sentences fails this guard even though the decision
  // is intact. That is deliberate — the sentences are the record — but it means
  // rewording one is a change to the decision's wording and must update this
  // list in the same commit.
  const requiredStatements = [
    'The repository intentionally does not use `CODEOWNERS` or path-based automatic review requests.',
    '`develop` requires no human approval and does not use CODEOWNER review.',
    '`main` requires no human approval and does not use CODEOWNER review.',
  ];

  const securityDoc = readSecurityDoc();
  for (const statement of requiredStatements) {
    assert.ok(
      securityDoc.includes(statement),
      `${securityDocPath} must keep stating: "${statement}". The file guard above enforces exactly `
        + 'what that document decides, so the two cannot drift apart.',
    );
  }
});

// A guard test is only as strong as the path that schedules it. Whether this
// file runs at all is decided by `ci/src/prValidationPlan.ts`, which gates the
// `Workflow contracts` job that owns `npm run ci:check`. Asserting the routing
// from this file — off the same arrays the assertions above use — means adding
// a location here cannot leave it unenforced in CI.
test('every guarded review-ownership path routes to the job that runs this guard', () => {
  // An empty manifest keeps this security guard independent of unrelated churn
  // in the server test runtime contracts; none of these paths select a test.
  const runtimeManifest = { schema: 'example.server-test-runtimes.v1', tests: [] };

  const plan = (input: Partial<Parameters<typeof derivePrValidationPlan>[0]>) => (
    derivePrValidationPlan(
      { changedFiles: [], deletedFiles: [], fileStatusAvailable: true, metadataOnly: false, ...input },
      runtimeManifest,
    )
  );

  for (const guardedPath of [...codeownersLocations, securityDocPath]) {
    // A rename reports only the new path as changed and the old one as deleted,
    // so moving the document away must route too — otherwise the guard leaves
    // with the decision it records.
    const shapes = [
      [`changing ${guardedPath}`, plan({ changedFiles: [guardedPath] })],
      [`renaming ${guardedPath} away`, plan({ changedFiles: ['docs/moved.md'], deletedFiles: [guardedPath] })],
      [`changing ${guardedPath} without file status`, plan({ changedFiles: [guardedPath], fileStatusAvailable: false })],
    ] as const;

    for (const [shape, derived] of shapes) {
      assert.equal(
        derived.workflowContractsRequired,
        true,
        `A pull request ${shape} must run the Workflow contracts job, which is the only job that `
          + 'runs this guard. Add it to `reviewOwnershipControlFiles` in ci/src/prValidationPlan.ts.',
      );
      // `docsOnly` is not what schedules this guard — the contracts job is
      // gated on `workflowContractsRequired` alone — so this pins the other
      // consequence: `lint` skips its own steps and stops being a required
      // lane on a documentation-only pull request.
      assert.equal(
        derived.docsOnly,
        false,
        `${guardedPath} decides review ownership rather than describing it, so a pull request `
          + `${shape} must not be classified as documentation-only, which would skip linting a `
          + 'change that is not documentation.',
      );
      // Routing these paths must not drag in server validation: they say nothing
      // about server behaviour, and making them server-relevant would spin up the
      // full suite and a database for a one-line change.
      assert.equal(derived.serverTestMode, 'none', `${shape} must not require server tests.`);
      assert.equal(
        derived.serverStaticRequired,
        false,
        `${shape} must not require server static validation.`,
      );
      assert.equal(derived.databaseRequired, false, `${shape} must not require a database.`);
    }
  }
});
