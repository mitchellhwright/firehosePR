import { REQUIRED_NATIVE_INPUTS, RETIRED_TEST_PRODUCT_INPUTS } from '../src/ios/testProductInputs.ts';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import type { TestContext } from 'node:test';
import { ExpressionValue } from 'gagen';
import { evaluateExpression } from './fixtures/actionsExpression.ts';
import { z } from 'zod';
import type { StepOutput } from '../src/ios/shared/stepIo.ts';
import { affectedUiOwners } from '../src/ios/affectedUiOwners.ts';
import { auxiliaryLanePaths, classifyIosChangedPaths } from '../src/ios/iosChangeClassification.ts';
import { accountUpdateShardSelection, simulatorCleanupPlan } from '../src/ios/executionPlan.ts';
import { deriveNativeExecutionPlan } from '../src/nativeExecutionPlan.ts';
import {
  completeIosChangeDetection,
  planIosChangeDetection,
} from '../src/ios/iosChangeGate.ts';
import { testIosExecution } from '../workflows/ios-tests/test-ios-execution.ts';
import { methodReadsResource } from '../src/ios/changedFileOwnership.ts';
import {
  parseSwiftTypeMethods,
  resourceReadingMethodKeys,
} from '../../scripts/swift-test-impact.ts';

/** The environment-derived half of a `Detect iOS Changes` output set. */
const gateContext = {
  forcedIosLanesRaw: '[]',
  reuseNativeEvidenceRaw: 'false',
  changedFilesDelimiter: 'CHANGED_FILES_1_1',
};
import { fileURLToPath } from 'node:url';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, '..', '..');
const selectorPath = path.join(repoRoot, 'scripts', 'select-ios-affected-tests.ts');
const workflowPath = path.join(repoRoot, '.github', 'workflows', 'ios-tests.yml');
const typedPlannerPath = path.join(repoRoot, 'ci', 'src', 'actions', 'planIosNative.ts');

const selectorOutputSchema = z.object({
  mode: z.string(), should_run: z.string(), test_count: z.string(),
  only_testing_file: z.string(), evidence_groups: z.string(),
  narrow_paywall_required: z.string(), account_update_test_count: z.string(),
  onboarding_required: z.string(), release_archive_required: z.string(),
  wellness_required: z.string(), wellness_only_testing_file: z.string(),
  wellness_test_count: z.string(),
});

interface SelectorInput {
  readonly changedFiles: string;
  readonly lane: string;
  readonly mode?: string;
  readonly base?: string;
  readonly head?: string;
  readonly objectDirectory?: string;
  readonly alternateObjectDirectory?: string;
  readonly githubEventName?: string;
  /** A product checkout other than this repository; history still comes from this repository. */
  readonly workspace?: string;
}

/** Bounds one selector run so a stuck child fails the test instead of hanging `ci:test`. */
const selectorTimeoutMs = 120_000;

function runSelector({
  changedFiles, lane, mode = 'affected', base = '', head = '',
  objectDirectory = '', alternateObjectDirectory = '', githubEventName, workspace,
}: SelectorInput) {
  const outputDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'example-ios-selector-'));
  const outputPath = path.join(outputDirectory, 'github-output.txt');
  const stepSummaryPath = path.join(outputDirectory, 'step-summary.md');
  const stdout = execFileSync('node', [selectorPath], {
    cwd: repoRoot,
    env: {
      ...process.env,
      GITHUB_BASE_REF: '',
      GITHUB_OUTPUT: outputPath,
      GITHUB_STEP_SUMMARY: stepSummaryPath,
      IOS_AFFECTED_TESTS_BASE: base,
      IOS_AFFECTED_TESTS_BASE_WORKFLOW: workflowPath,
      IOS_AFFECTED_TESTS_CHANGED_FILES: changedFiles,
      IOS_AFFECTED_TESTS_HEAD: head,
      IOS_AFFECTED_TESTS_LANE: lane,
      IOS_AFFECTED_TESTS_MODE: mode,
      ...(workspace ? {
        IOS_AFFECTED_TESTS_WORKSPACE: workspace,
        GIT_DIR: execFileSync('git', ['rev-parse', '--absolute-git-dir'], {
          cwd: repoRoot, encoding: 'utf8',
        }).trim(),
      } : {}),
      GITHUB_ACTIONS: 'true',
      GITHUB_EVENT_NAME: githubEventName ?? (mode === 'full' ? 'workflow_dispatch' : 'pull_request'),
      ...(objectDirectory ? {
        GIT_OBJECT_DIRECTORY: objectDirectory,
        GIT_ALTERNATE_OBJECT_DIRECTORIES: alternateObjectDirectory,
      } : {}),
    },
    encoding: 'utf8',
    timeout: selectorTimeoutMs,
    // A rejection a test expects travels in the thrown error's message. Echoing
    // it to this process's stderr put selector errors such as "Unowned Xcode
    // project edit" in every Workflow contracts log, passing or not, where they
    // read as the cause of an unrelated failure.
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const outputs = selectorOutputSchema.parse(Object.fromEntries(
    fs
      .readFileSync(outputPath, 'utf8')
      .trim()
      .split('\n')
      .filter((line) => line.includes('=') && !line.includes('<<'))
      .map((line) => {
        const separator = line.indexOf('=');
        return [line.slice(0, separator), line.slice(separator + 1)];
      })
  ));
  const stepSummary = fs.existsSync(stepSummaryPath) ? fs.readFileSync(stepSummaryPath, 'utf8') : '';
  return { ...outputs, stepSummary, stdout };
}

/** An unprovable generated model widens the lane to the full native suite and says why. */
function assertFullEscalation(selection: ReturnType<typeof runSelector>, detail: RegExp): void {
  assert.equal(selection.mode, 'full');
  assert.equal(selection.should_run, 'true');
  assert.equal(selection.only_testing_file, '');
  assert.equal(selection.release_archive_required, 'true');
  assert.match(selection.stepSummary, /escalated to the full native suite/);
  assert.match(selection.stepSummary, /Reason: full: generated model change not provable: ios\/example-ios\/Models\/Generated\//);
  assert.match(selection.stepSummary, detail);
}

/** Copy the selector's product inputs (test sources and plans) with `edits` applied. */
function syntheticWorkspace(
  t: TestContext,
  edits: Readonly<Record<string, (source: string) => string>>,
): string {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'example-ios-workspace-'));
  t.after(() => fs.rmSync(workspace, { recursive: true, force: true }));
  for (const directory of ['ios/example-iosTests', 'ios/example-iosUITests', 'ios/example-ios.xcodeproj']) {
    fs.cpSync(path.join(repoRoot, directory), path.join(workspace, directory), { recursive: true });
  }
  for (const [relativePath, edit] of Object.entries(edits)) {
    const target = path.join(workspace, relativePath);
    fs.writeFileSync(target, edit(fs.readFileSync(target, 'utf8')));
  }
  return workspace;
}

interface SyntheticEdit { readonly relativePath: string; readonly sourceNeedle: string }

function syntheticObjectEnvironment(temporary: string) {
  const objectDirectory = path.join(temporary, 'objects');
  fs.mkdirSync(objectDirectory);
  const gitCommonDir = execFileSync('git', ['rev-parse', '--git-common-dir'], {
    cwd: repoRoot, encoding: 'utf8',
  }).trim();
  return {
    objectDirectory,
    alternateObjectDirectory: path.join(path.resolve(repoRoot, gitCommonDir), 'objects'),
    GIT_OBJECT_DIRECTORY: objectDirectory,
    GIT_ALTERNATE_OBJECT_DIRECTORIES: path.join(path.resolve(repoRoot, gitCommonDir), 'objects'),
  };
}

/** Bounds each synthetic-history git call so a stuck child fails the test instead of hanging it. */
const syntheticGitTimeoutMs = 30_000;

/**
 * Git commands that write synthetic history into `temporary`'s object store and index.
 *
 * Nothing is written to git's stdin. On macOS a `spawnSync` `input` larger than the
 * socket buffer (about 64 KiB, e.g. project.pbxproj) can lose its writable wakeup,
 * leaving `git hash-object --stdin` and the test process waiting on each other forever.
 * Blob content goes through a file and commit messages through `-m` instead.
 */
function syntheticGit(temporary: string, objectEnvironment: Record<string, string>) {
  const env = {
    ...process.env, ...objectEnvironment,
    GIT_AUTHOR_EMAIL: 'ci-selector@example.invalid',
    GIT_AUTHOR_NAME: 'CI selector contract',
    GIT_COMMITTER_EMAIL: 'ci-selector@example.invalid',
    GIT_COMMITTER_NAME: 'CI selector contract',
    GIT_INDEX_FILE: path.join(temporary, 'index'),
  };
  const git = (args: readonly string[]) => execFileSync('git', args, {
    cwd: repoRoot, encoding: 'utf8', env,
    stdio: ['ignore', 'pipe', 'pipe'], timeout: syntheticGitTimeoutMs,
  }).trim();
  const blobPath = path.join(temporary, 'blob');
  const hashBlob = (content: string) => {
    fs.writeFileSync(blobPath, content);
    return git(['hash-object', '-w', '--no-filters', '--', blobPath]);
  };
  return { git, hashBlob };
}

function syntheticMethodOnlyHistory(
  t: TestContext,
  relativePathOrEdits: string | readonly SyntheticEdit[],
  sourceNeedle?: string,
): { base: string; head: string; objectDirectory: string; alternateObjectDirectory: string } {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'example-ios-method-history-'));
  t.after(() => fs.rmSync(temporary, { recursive: true, force: true }));
  const edits: readonly SyntheticEdit[] = typeof relativePathOrEdits === 'string'
    ? [{ relativePath: relativePathOrEdits, sourceNeedle: sourceNeedle ?? '' }]
    : relativePathOrEdits;
  const objectEnvironment = syntheticObjectEnvironment(temporary);
  const { git, hashBlob } = syntheticGit(temporary, objectEnvironment);

  git(['read-tree', 'HEAD']);
  for (const edit of edits) {
    const source = fs.readFileSync(path.join(repoRoot, edit.relativePath), 'utf8');
    assert.ok(
      source.includes(edit.sourceNeedle),
      `missing synthetic edit anchor in ${edit.relativePath}`,
    );
    const priorSource = source.replace(
      edit.sourceNeedle,
      `${edit.sourceNeedle.trimEnd()} // prior revision\n`,
    );
    const priorBlob = hashBlob(priorSource);
    git(['update-index', '--cacheinfo', `100644,${priorBlob},${edit.relativePath}`]);
  }
  const priorTree = git(['write-tree']);
  const base = git(['commit-tree', priorTree, '-m', 'synthetic base']);
  const headTree = git(['rev-parse', 'HEAD^{tree}']);
  const head = git(['commit-tree', headTree, '-p', base, '-m', 'synthetic head']);
  return { base, head, ...objectEnvironment };
}

function syntheticGeneratedSwiftHead(
  t: TestContext,
  source: string,
  testSource?: string,
  baseSource?: string,
  generatedPath = 'ios/example-ios/Models/Generated/ChatTypes.generated.swift',
): { base: string; head: string; objectDirectory: string; alternateObjectDirectory: string } {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'example-generated-swift-history-'));
  t.after(() => fs.rmSync(temporary, { recursive: true, force: true }));
  const objectEnvironment = syntheticObjectEnvironment(temporary);
  const { git, hashBlob } = syntheticGit(temporary, objectEnvironment);
  let base = git(['rev-parse', 'HEAD']);
  git(['read-tree', base]);
  if (baseSource !== undefined) {
    const baseBlob = hashBlob(baseSource);
    git(['update-index', '--cacheinfo',
      `100644,${baseBlob},${generatedPath}`]);
    const baseTree = git(['write-tree']);
    base = git(['commit-tree', baseTree, '-p', base, '-m', 'synthetic generated Swift base']);
    git(['read-tree', base]);
  }
  const blob = hashBlob(source);
  git(['update-index', '--cacheinfo',
    `100644,${blob},${generatedPath}`]);
  if (testSource) {
    const testBlob = hashBlob(testSource);
    git(['update-index', '--cacheinfo',
      `100644,${testBlob},ios/example-iosTests/ChatHistoryMessageContractTests.swift`]);
  }
  const tree = git(['write-tree']);
  const head = git(['commit-tree', tree, '-p', base, '-m', 'synthetic generated Swift head']);
  return { base, head, ...objectEnvironment };
}

function syntheticProjectResourceHead(t: TestContext): {
  base: string; head: string; objectDirectory: string; alternateObjectDirectory: string;
} {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'example-project-resource-history-'));
  t.after(() => fs.rmSync(temporary, { recursive: true, force: true }));
  const objectEnvironment = syntheticObjectEnvironment(temporary);
  const { git, hashBlob } = syntheticGit(temporary, objectEnvironment);
  const base = git(['rev-parse', 'HEAD']);
  git(['read-tree', base]);
  const projectPath = 'ios/example-ios.xcodeproj/project.pbxproj';
  const project = fs.readFileSync(path.join(repoRoot, projectPath), 'utf8');
  const fixtures = ['mortgage-chat-refinance.json', 'mortgage-chat-infeasible.json'];
  const identifiers = ['A60901383000000000000001', 'A60901383000000000000002'];
  const references = ['A60901383000000000000003', 'A60901383000000000000004'];
  const buildLines = fixtures.map((name, index) =>
    `\t\t${identifiers[index]} /* ${name} in Resources */ = {isa = PBXBuildFile; fileRef = ${references[index]} /* ${name} */; };`
  ).join('\n');
  const referenceLines = fixtures.map((name, index) =>
    `\t\t${references[index]} /* ${name} */ = {isa = PBXFileReference; lastKnownFileType = text.json; path = ../server/testdata/${name}; sourceTree = SOURCE_ROOT; };`
  ).join('\n');
  const changed = project
    .replace('/* Begin PBXBuildFile section */', `/* Begin PBXBuildFile section */\n${buildLines}`)
    .replace('/* Begin PBXFileReference section */', `/* Begin PBXFileReference section */\n${referenceLines}`)
    .replace('MARKETING_VERSION = 1.5.1;', 'MARKETING_VERSION = 1.5.2;');
  // The group and Resources-phase references are also present in the real PR.
  // Adding them here proves they do not select unrelated test targets.
  const withMembership = changed.replace('children = (', `children = (\n${fixtures.map((name, index) =>
    `\t\t\t\t${references[index]} /* ${name} */,`).join('\n')}`)
    .replace('files = (', `files = (\n${fixtures.map((name, index) =>
      `\t\t\t\t${identifiers[index]} /* ${name} in Resources */,`).join('\n')}`);
  assert.notEqual(withMembership, project);
  const blob = hashBlob(withMembership);
  git(['update-index', '--cacheinfo', `100644,${blob},${projectPath}`]);
  const tree = git(['write-tree']);
  const head = git(['commit-tree', tree, '-p', base, '-m', 'synthetic resource project head']);
  return { base, head, ...objectEnvironment };
}

type SyntheticFileEdit = ((source: string) => string) | null;

/**
 * Commit the current tree with `edits` applied on one side of a synthetic
 * base/head pair. Editing the base makes the current tree add what the edits
 * removed, exactly as a pull request that introduces it; editing the head
 * makes the pull request perform the edits.
 */
function syntheticEditedHistory(
  t: TestContext,
  editedSide: 'base' | 'head',
  edits: Readonly<Record<string, SyntheticFileEdit>>,
  additionalHeadEdits: Readonly<Record<string, SyntheticFileEdit>> = {},
): { base: string; head: string; objectDirectory: string; alternateObjectDirectory: string } {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'example-edited-history-'));
  t.after(() => fs.rmSync(temporary, { recursive: true, force: true }));
  const objectEnvironment = syntheticObjectEnvironment(temporary);
  const { git, hashBlob } = syntheticGit(temporary, objectEnvironment);
  const current = git(['rev-parse', 'HEAD']);
  git(['read-tree', current]);
  for (const [relativePath, edit] of Object.entries(edits)) {
    if (edit === null) {
      git(['update-index', '--force-remove', relativePath]);
      continue;
    }
    const source = fs.readFileSync(path.join(repoRoot, relativePath), 'utf8');
    const edited = edit(source);
    assert.notEqual(edited, source, `${relativePath} edit must change the file`);
    const blob = hashBlob(edited);
    git(['update-index', '--cacheinfo', `100644,${blob},${relativePath}`]);
  }
  const editedTree = git(['write-tree']);
  if (editedSide === 'head') {
    return { base: current, head: git(['commit-tree', editedTree, '-p', current, '-m', 'synthetic edited head']),
      ...objectEnvironment };
  }
  const base = git(['commit-tree', editedTree, '-p', current, '-m', 'synthetic edited base']);
  git(['read-tree', current]);
  for (const [relativePath, edit] of Object.entries(additionalHeadEdits)) {
    assert.ok(edit, `${relativePath} additional head edit must write a file`);
    const source = fs.readFileSync(path.join(repoRoot, relativePath), 'utf8');
    const edited = edit(source);
    assert.notEqual(edited, source, `${relativePath} additional head edit must change the file`);
    const blob = hashBlob(edited);
    git(['update-index', '--cacheinfo', `100644,${blob},${relativePath}`]);
  }
  const head = git(['commit-tree', git(['write-tree']), '-p', base, '-m', 'synthetic current head']);
  return { base, head, ...objectEnvironment };
}

const projectPath = 'ios/example-ios.xcodeproj/project.pbxproj';
const testPlanPath = (name: string) => `ios/example-ios.xcodeproj/xcshareddata/TestPlans/${name}.xctestplan`;
const wellnessSchemePath = 'ios/example-ios.xcodeproj/xcshareddata/xcschemes/example-ios.xcscheme';
const wellnessSchemeReference = '         <TestPlanReference\n'
  + '            reference = "container:example-ios.xcodeproj/xcshareddata/TestPlans/WLC02-Live.xctestplan">\n'
  + '         </TestPlanReference>\n';
const withoutLines = (line: string, expected: number) => (source: string) => {
  assert.equal(source.split(line).length - 1, expected, `expected ${expected} copies of ${line.trim()}`);
  return source.replaceAll(line, '');
};

// The #6052 registration: a new UI class, both E2E-target exclusions and both CI plan entries.
const newUiClassRegistration = {
  'ios/example-iosUITests/AccountDeletionGuidanceUITests.swift': null,
  [projectPath]: withoutLines('\t\t\t\tAccountDeletionGuidanceUITests.swift,\n', 2),
  [testPlanPath('CI')]: withoutLines('        "AccountDeletionGuidanceUITests",\n', 1),
  [testPlanPath('CI-UI')]: withoutLines('        "AccountDeletionGuidanceUITests",\n', 1),
};

test('a new UI test class registered in the project and CI plans selects only that class', (t) => {
  const history = syntheticEditedHistory(t, 'base', newUiClassRegistration);
  const changedFiles = Object.keys(newUiClassRegistration).join('\n');
  const main = runSelector({ changedFiles, lane: 'main', ...history });
  assert.equal(main.mode, 'affected');
  assert.equal(main.should_run, 'true');
  assert.equal(main.onboarding_required, 'false');
  assert.equal(main.release_archive_required, 'true');
  assert.deepEqual(fs.readFileSync(main.only_testing_file, 'utf8').trim().split('\n'), [
    'example-iosUITests/AccountDeletionGuidanceUITests',
  ]);
  const evidence = runSelector({ changedFiles, lane: 'evidence', ...history });
  assert.equal(evidence.mode, 'affected');
  assert.equal(evidence.test_count, '0');
  assert.equal(evidence.should_run, 'false');
});

// A promotion carries #6052's exclusions and #6278's warnings mapping in one project diff.
const warningsMapping = '\t\t\t\tSWIFT_TREAT_WARNINGS_AS_ERRORS = "$(EXAMPLE_CI_SWIFT_WARNINGS_AS_ERRORS)";\n';
const promotionRegistration = {
  ...newUiClassRegistration,
  [projectPath]: (source: string) => withoutLines(warningsMapping, 2)(
    withoutLines('\t\t\t\tAccountDeletionGuidanceUITests.swift,\n', 2)(source)),
};

test('a promotion project edit combining new-test exclusions and the warnings mapping stays owned', (t) => {
  const history = syntheticEditedHistory(t, 'base', promotionRegistration);
  const changedFiles = Object.keys(promotionRegistration).join('\n');
  const main = runSelector({ changedFiles, lane: 'main', ...history });
  assert.equal(main.mode, 'affected');
  assert.equal(main.release_archive_required, 'true');
  assert.deepEqual(fs.readFileSync(main.only_testing_file, 'utf8').trim().split('\n'), [
    'example-iosUITests/AccountDeletionGuidanceUITests',
  ]);
  const unownedSetting = syntheticEditedHistory(t, 'base', promotionRegistration, {
    [projectPath]: (source) => source.replace('SWIFT_COMPILATION_MODE = wholemodule;', 'SWIFT_COMPILATION_MODE = singlefile;'),
  });
  assert.throws(() => runSelector({ changedFiles, lane: 'main', ...unownedSetting }),
    /Unowned Xcode project edit in ios\/example-ios\.xcodeproj\/project\.pbxproj/);
});

test('a new UI test excluded from its executing target is not owned by the project edit', (t) => {
  const ownTargetException = /((?:Exceptions for "example-iosUITests" folder in "example-iosUITests" target \*\/ = \{\n\t\t\tisa = PBXFileSystemSynchronizedBuildFileExceptionSet;\n\t\t\tmembershipExceptions = \(\n))/;
  const history = syntheticEditedHistory(t, 'base', newUiClassRegistration, {
    [projectPath]: (source) => {
      assert.match(source, ownTargetException);
      return source.replace(ownTargetException, '$1\t\t\t\tAccountDeletionGuidanceUITests.swift,\n');
    },
  });
  const changedFiles = Object.keys(newUiClassRegistration).join('\n');
  for (const lane of ['main', 'evidence']) {
    assert.throws(() => runSelector({ changedFiles, lane, ...history }),
      /Unowned Xcode project edit in ios\/example-ios\.xcodeproj\/project\.pbxproj/);
  }
});

test('project and plan edits that remove, skip or reconfigure tests still need an explicit owner', (t) => {
  const unowned: readonly (readonly [string, 'base' | 'head', Readonly<Record<string, SyntheticFileEdit>>, RegExp])[] = [
    ['a removed CI plan class stops running tests', 'head',
      { [testPlanPath('CI')]: withoutLines('        "AccountDeletionGuidanceUITests",\n', 1) },
      /Xcode build\/test-plan semantics need an explicit changed-target owner/],
    ['a plan option changes every test', 'head',
      { [testPlanPath('CI')]: (source) => source.replace('"testTimeoutsEnabled" : false', '"testTimeoutsEnabled" : true') },
      /Xcode build\/test-plan semantics need an explicit changed-target owner/],
    ['a scheme is not a test selector', 'head',
      { 'ios/example-ios.xcodeproj/xcshareddata/xcschemes/example-ios-Unit.xcscheme':
        (source) => source.replace('<AnalyzeAction buildConfiguration = "Debug">', '<AnalyzeAction buildConfiguration = "Release">') },
      /Cannot narrow .*example-ios-Unit\.xcscheme/],
    // Whichever file a pull request lists first, it already exists in the base.
    ['an existing file leaves the onboarding target', 'base',
      { [projectPath]: (source) => source.replace(
        /("example-iosOnboardingUITests" target \*\/ = \{\n\t\t\tisa = PBXFileSystemSynchronizedBuildFileExceptionSet;\n\t\t\tmembershipExceptions = \(\n)\t\t\t\t[^\n]+\n/,
        '$1') },
      /Unowned Xcode project edit in ios\/example-ios\.xcodeproj\/project\.pbxproj/],
    // A class no plan selects today stays independent of which classes CI adopts.
    ['a CI-UI class that neither CI lane executes', 'head',
      { [testPlanPath('CI-UI')]: (source) => {
        const plan = z.object({
          testTargets: z.array(z.object({
            target: z.object({ name: z.string() }).passthrough(),
            selectedTests: z.array(z.string()).optional(),
          }).passthrough()),
        }).passthrough().parse(JSON.parse(source));
        const uiTarget = plan.testTargets.find((target) => target.target.name === 'example-iosUITests');
        assert.ok(uiTarget?.selectedTests, 'CI-UI lists example-iosUITests selections');
        uiTarget.selectedTests.push('UnselectedByCILanesUITests');
        return JSON.stringify(plan, null, 2);
      } },
      /CI-UI\.xctestplan enables example-iosUITests\/UnselectedByCILanesUITests, which no CI lane plan executes/],
  ];
  for (const [reason, editedSide, edits, error] of unowned) {
    const history = syntheticEditedHistory(t, editedSide, edits);
    for (const lane of ['main', 'evidence']) {
      assert.throws(() => runSelector({ changedFiles: Object.keys(edits).join('\n'), lane, ...history }),
        error, `${reason} (${lane})`);
    }
  }
});

const testPlanDirectory = path.join(repoRoot, path.dirname(testPlanPath('CI')));
const testPlanSources = () => fs.readdirSync(testPlanDirectory)
  .filter((name) => name.endsWith('.xctestplan'))
  .map((name) => fs.readFileSync(path.join(testPlanDirectory, name), 'utf8'));

/** A pull request head checkout, where the deleted test source no longer exists. */
function workspaceWithout(t: TestContext, deletedPath: string): string {
  const workspace = syntheticWorkspace(t, {});
  fs.rmSync(path.join(workspace, deletedPath));
  return workspace;
}

test('deleting a UI test that no test plan executed selects no tests', (t) => {
  const deletedPath = 'ios/example-iosUITests/UXBugAuditUITests.swift';
  assert.ok(testPlanSources().every((plan) => !plan.includes('"UXBugAuditUITests')),
    'fixture class must be absent from every test plan');
  const history = syntheticEditedHistory(t, 'head', { [deletedPath]: null });
  const workspace = workspaceWithout(t, deletedPath);
  for (const lane of ['main', 'evidence']) {
    const selection = runSelector({ changedFiles: deletedPath, lane, workspace, ...history });
    assert.equal(selection.mode, 'skip', lane);
    assert.equal(selection.should_run, 'false', lane);
    assert.equal(selection.test_count, '0', lane);
  }
  // Only the deletion is exempt: editing the same unplanned test still has no CI owner.
  const edited = syntheticEditedHistory(t, 'head', {
    [deletedPath]: (source) => `${source}\n// edited\n`,
  });
  for (const lane of ['main', 'evidence']) {
    assert.throws(() => runSelector({ changedFiles: deletedPath, lane, ...edited }),
      /UXBugAuditUITests\.swift is not selected by CI\.xctestplan/, lane);
  }
});

const unplannedDeletedTest = 'ios/example-iosUITests/UXBugAuditUITests.swift';
// The onboarding and budget/debt UI targets both opt the file out by name.
const deletedTestExclusions = withoutLines('\t\t\t\tUXBugAuditUITests.swift,\n', 2);

test('deleting an unplanned UI test with its target exclusions selects no tests', (t) => {
  const history = syntheticEditedHistory(t, 'head', {
    [unplannedDeletedTest]: null,
    [projectPath]: deletedTestExclusions,
  });
  const workspace = workspaceWithout(t, unplannedDeletedTest);
  const changedFiles = [unplannedDeletedTest, projectPath].join('\n');
  for (const lane of ['main', 'evidence']) {
    const selection = runSelector({ changedFiles, lane, workspace, ...history });
    assert.equal(selection.mode, 'skip', lane);
    assert.equal(selection.should_run, 'false', lane);
    assert.equal(selection.test_count, '0', lane);
  }
});

test('a version bump alongside an owned exclusion removal keeps the archive instead of skipping', (t) => {
  const history = syntheticEditedHistory(t, 'head', {
    [unplannedDeletedTest]: null,
    [projectPath]: (source) => deletedTestExclusions(source)
      .replace(/MARKETING_VERSION = [0-9.]+;/, 'MARKETING_VERSION = 99.0.0;'),
  });
  const workspace = workspaceWithout(t, unplannedDeletedTest);
  const changedFiles = [unplannedDeletedTest, projectPath].join('\n');
  for (const lane of ['main', 'evidence']) {
    const selection = runSelector({ changedFiles, lane, workspace, ...history });
    assert.equal(selection.mode, 'affected', lane);
    assert.equal(selection.release_archive_required, 'true', lane);
    assert.equal(selection.test_count, '0', lane);
  }
});

test('removing target exclusions still needs an owner unless the diff deletes each file', (t) => {
  const existingExclusion = withoutLines('\t\t\t\tWealthGoalsRetirementSurfaceHandoffUITests.swift,\n', 2);
  const unowned: readonly (readonly [string, Readonly<Record<string, SyntheticFileEdit>>, readonly string[]])[] = [
    ['exclusions removed without deleting the file',
      { [projectPath]: deletedTestExclusions }, [projectPath]],
    ['the deletion is not one of the changed files',
      { [unplannedDeletedTest]: null, [projectPath]: deletedTestExclusions }, [projectPath]],
    ['an exclusion removed for a file that still exists',
      { [unplannedDeletedTest]: null,
        [projectPath]: (source) => existingExclusion(deletedTestExclusions(source)) },
      [unplannedDeletedTest, projectPath]],
    // The project is listed first so its own verdict is the one reported.
    ['an exclusion removed for a changed file that still exists',
      { [unplannedDeletedTest]: (source) => `${source}\n// edited\n`, [projectPath]: deletedTestExclusions },
      [projectPath, unplannedDeletedTest]],
    ['an unowned build setting alongside the exclusion removal',
      { [unplannedDeletedTest]: null,
        [projectPath]: (source) => deletedTestExclusions(source)
          .replace('SWIFT_COMPILATION_MODE = wholemodule;', 'SWIFT_COMPILATION_MODE = singlefile;') },
      [unplannedDeletedTest, projectPath]],
  ];
  const workspace = workspaceWithout(t, unplannedDeletedTest);
  for (const [reason, edits, changed] of unowned) {
    const history = syntheticEditedHistory(t, 'head', edits);
    for (const lane of ['main', 'evidence']) {
      assert.throws(() => runSelector({ changedFiles: changed.join('\n'), lane, workspace, ...history }),
        /Unowned Xcode project edit in ios\/example-ios\.xcodeproj\/project\.pbxproj/, `${reason} (${lane})`);
    }
  }
});

test('deleting a planned test with its target exclusions keeps the deletion fail-closed', (t) => {
  const deletedPath = 'ios/example-iosUITests/AccountDeletionGuidanceUITests.swift';
  const history = syntheticEditedHistory(t, 'head', {
    [deletedPath]: null,
    [projectPath]: withoutLines('\t\t\t\tAccountDeletionGuidanceUITests.swift,\n', 2),
  });
  const workspace = workspaceWithout(t, deletedPath);
  for (const lane of ['main', 'evidence']) {
    assert.throws(() => runSelector({ changedFiles: [deletedPath, projectPath].join('\n'), lane, workspace, ...history }),
      /AccountDeletionGuidanceUITests\.swift is not selected by CI\.xctestplan/, lane);
  }
});

test('a removed app source is owned by the tests that still name it, not by its directory', (t) => {
  // The synthetic head checkout copies only tests and the project, so every
  // app source below is absent from it, as a deleted file would be.
  const workspace = syntheticWorkspace(t, {});
  const named = runSelector({
    changedFiles: 'ios/example-ios/UI/Cards/Budget/CategoryManagerView.swift', lane: 'main', workspace,
  });
  assert.equal(named.mode, 'affected');
  assert.match(fs.readFileSync(named.only_testing_file, 'utf8'),
    /^example-iosTests\/CategoryManagerDeletionGuardTests$/m);

  assert.throws(() => runSelector({
    changedFiles: 'ios/example-ios/UI/Cards/Budget/NeverNamedBudgetWidget.swift', lane: 'main', workspace,
  }), /NeverNamedBudgetWidget\.swift was removed and no CI test names it/);
});

test('deleting a test that a test plan executed still needs an explicit owner', (t) => {
  const planned: readonly (readonly [string, string])[] = [
    ['ios/example-iosUITests/AccountDeletionGuidanceUITests.swift', '"AccountDeletionGuidanceUITests"'],
    // CI-E2E runs every class compiled into the budget/debt target.
    ['ios/example-iosUITests/BudgetCashflowChartFixtureSizeUITests.swift', '"example-iosBudgetDebtUITests"'],
  ];
  for (const [deletedPath, planEntry] of planned) {
    assert.ok(testPlanSources().some((plan) => plan.includes(planEntry)), `${planEntry} is planned`);
    const history = syntheticEditedHistory(t, 'head', { [deletedPath]: null });
    const workspace = workspaceWithout(t, deletedPath);
    for (const lane of ['main', 'evidence']) {
      assert.throws(() => runSelector({ changedFiles: deletedPath, lane, workspace, ...history }),
        /is not selected by CI\.xctestplan/, `${deletedPath} (${lane})`);
    }
  }
});

test('project resource and version diff selects the two mortgage XCTest methods plus Release archive', (t) => {
  const history = syntheticProjectResourceHead(t);
  const selection = runSelector({
    changedFiles: 'ios/example-ios.xcodeproj/project.pbxproj', lane: 'main', ...history,
  });
  assert.equal(selection.mode, 'affected');
  assert.equal(selection.release_archive_required, 'true');
  assert.equal(selection.test_count, '2');
  assert.deepEqual(fs.readFileSync(selection.only_testing_file, 'utf8').trim().split('\n'), [
    'example-iosTests/CanonicalMortgageChatPayloadTests/testInfeasibleSameOutflowUsesContractualMetricsInExistingCard',
    'example-iosTests/CanonicalMortgageChatPayloadTests/testRegisteredRefinanceSerializerReachesExistingNativeCard',
  ]);
});

test('Info.plist and launch assets keep their compiled configuration contract owners', () => {
  const plist = runSelector({ changedFiles: 'ios/example-ios/Info.plist', lane: 'main' });
  assert.equal(plist.mode, 'affected');
  assert.equal(plist.release_archive_required, 'true');
  assert.deepEqual(fs.readFileSync(plist.only_testing_file, 'utf8').trim().split('\n'), [
    'example-iosTests/LaunchScreenConfigurationTests',
    'example-iosTests/PortraitOrientationContractTests',
  ]);
  const asset = runSelector({
    changedFiles: 'ios/example-ios/Assets.xcassets/LaunchScreenBackground.colorset/Contents.json',
    lane: 'main',
  });
  assert.deepEqual(fs.readFileSync(asset.only_testing_file, 'utf8').trim().split('\n'), [
    'example-iosTests/LaunchScreenConfigurationTests',
  ]);
});

test('new notification fixture routes only methods loading its stem and extension', () => {
  const selection = runSelector({
    changedFiles: 'ios/example-iosTests/Notifications/Fixtures/insight-route.apns',
    lane: 'main',
  });
  assert.equal(selection.mode, 'affected');
  const selected = fs.readFileSync(selection.only_testing_file, 'utf8');
  assert.match(selected, /NotificationRouteFixtureTests\/testRoutingFixtureDecodesToTheOpaqueReference/);
  assert.match(selected, /NotificationForegroundDelegateTests\/testHandleRoutedNotificationResponseRecordsPendingIntentAndNotifies/);
  assert.doesNotMatch(selected, /NotificationForegroundDelegateTests\/testHandleRoutedNotificationResponseDropsAMalformedPayloadWithoutRecordingOrNotifying/);
});

test('the main lane leaves StoreKit tests to the StoreKit Purchase lane', () => {
  // The main pass skips example-iosStoreKitTests, and its affected-UI counter
  // rejects selectors outside the UI targets.
  const selection = runSelector({ changedFiles: 'ios/example-ios/UI/PaywallView.swift', lane: 'main' });
  assert.equal(selection.mode, 'affected');
  const selected = fs.readFileSync(selection.only_testing_file, 'utf8').trim().split('\n');
  assert.ok(selected.includes('example-iosUITests/PaywallLegalFooterUITests'), selected.join('\n'));
  assert.deepEqual(selected.filter((identifier) => identifier.startsWith('example-iosStoreKitTests')), []);
  assert.equal(selection.test_count, String(selected.length));
});

test('resource selection follows private fixture helpers to executable XCTest callers', () => {
  const selection = runSelector({
    changedFiles: 'ios/example-iosTests/Notifications/Fixtures/level-destination-parity.json',
    lane: 'main',
  });
  assert.equal(selection.mode, 'affected');
  const selected = fs.readFileSync(selection.only_testing_file, 'utf8').trim().split('\n');
  assert.deepEqual(selected, [
    'example-iosTests/NotificationDestinationResolverTests/testAmbiguousSemanticTargetAndMissingInAppContractFallBackHonestly',
    'example-iosTests/NotificationDestinationResolverTests/testGraceContextPreservesDeadlineAndReceiptIdentity',
    'example-iosTests/NotificationDestinationResolverTests/testHistoricalMilestoneUsesRetainedFactsInsteadOfCurrentJourney',
    'example-iosTests/NotificationDestinationResolverTests/testRealSourceP01P01bP02P03PayloadsShareExactNativeDestination',
  ]);
  assert.ok(selected.every((identifier) => !identifier.endsWith('/parityFixtures')));
});

const sharedFixtureHelperSource = `
struct GuidanceFixture: Decodable {
    static func load() throws -> Self {
        let url = Bundle.main.url(forResource: "guidance", withExtension: "json")!
        return try JSONDecoder().decode(Self.self, from: Data(contentsOf: url))
    }
    static func render() -> String { "" }
}

extension DecodingTests {
    func testCardReadsFixture() throws { _ = try GuidanceFixture.load() }
    func testCardOnlyRenders() { _ = GuidanceFixture.render() }
}
`;
const helperConsumerSource = `
final class DashboardTests: XCTestCase {
    private func fixture() throws -> GuidanceFixture { try GuidanceFixture.load() }
    func testDashboardReadsFixtureThroughPrivateLoader() throws { _ = try fixture() }
    func testDashboardIgnoresFixture() { XCTAssertTrue(true) }
    func testUnrelatedLoadIsNotTheHelper() { load() }
    private func load() {}
}
`;

test('Swift type parsing attributes extension methods to the extended type', () => {
  const methods = parseSwiftTypeMethods(sharedFixtureHelperSource);
  assert.deepEqual(methods.map((method) => `${method.className}.${method.name}`), [
    'GuidanceFixture.load',
    'GuidanceFixture.render',
    'DecodingTests.testCardReadsFixture',
    'DecodingTests.testCardOnlyRenders',
  ]);
  assert.deepEqual(methods[2]?.qualifiedCalls, ['GuidanceFixture.load']);
});

test('resource readers follow shared helper types across test sources', () => {
  const readers = resourceReadingMethodKeys([sharedFixtureHelperSource, helperConsumerSource],
    (source, body) => methodReadsResource('guidance.json', source, body));
  assert.deepEqual([...readers].sort(), [
    'DashboardTests.fixture',
    'DashboardTests.testDashboardReadsFixtureThroughPrivateLoader',
    'DecodingTests.testCardReadsFixture',
    'GuidanceFixture.load',
  ]);
});

test('resource readers stay empty when no helper reads the resource', () => {
  const readers = resourceReadingMethodKeys([sharedFixtureHelperSource, helperConsumerSource],
    (source, body) => methodReadsResource('other.json', source, body));
  assert.equal(readers.size, 0);
});

test('iOS Markdown outside ios/docs remains documentation-only alongside executable changes', () => {
  const documentation = runSelector({
    changedFiles: 'ios/BUDGET_DASHBOARD_REFACTOR.md\nios/fastlane/README.md\nios/.swiftlint.yml',
    lane: 'main',
  });
  assert.equal(documentation.mode, 'skip');
  const mixed = runSelector({
    changedFiles: 'ios/example-ios/Info.plist\nios/example-ios/Components/README.md\nios/.swiftlint.yml',
    lane: 'main',
  });
  assert.equal(mixed.mode, 'affected');
  assert.equal(mixed.release_archive_required, 'true');
  assert.equal(mixed.test_count, '2');
});

/** The main-lane selection of one selector run, as the `-only-testing` file lists it. */
function selectedTests(selection: ReturnType<typeof runSelector>): string[] {
  return fs.readFileSync(selection.only_testing_file, 'utf8').trim().split(/\r?\n/);
}

test('an added optional generated field narrows to referencing and wire-contract tests', (t) => {
  const changedFiles = 'ios/example-ios/Models/Generated/ChatTypes.generated.swift';
  const source = fs.readFileSync(path.join(repoRoot, changedFiles), 'utf8');
  const start = source.indexOf('public struct ChatHistoryMessage:');
  const end = source.indexOf('\npublic struct ChatHistoryBubble:', start);
  assert.ok(start >= 0 && end > start);
  const declaration = source.slice(start, end);
  const fieldAlreadyPresent = declaration.includes('    public var conversationId: String?\n');
  const baseDeclaration = fieldAlreadyPresent
    ? declaration
      .replace('    public var conversationId: String?\n', '')
      .replace('        conversationId: String? = nil,\n', '')
      .replace('        self.conversationId = conversationId\n', '')
    : declaration;
  const extended = fieldAlreadyPresent ? declaration : declaration
    .replace('    public var isUser: Bool\n',
      '    public var isUser: Bool\n    public var conversationId: String?\n')
    .replace('        isUser: Bool,\n',
      '        isUser: Bool,\n        conversationId: String? = nil,\n')
    .replace('        self.isUser = isUser\n',
      '        self.isUser = isUser\n        self.conversationId = conversationId\n');
  assert.notEqual(extended, baseDeclaration);
  const syntheticBaseSource = source.slice(0, start) + baseDeclaration + source.slice(end);
  const syntheticHeadSource = source.slice(0, start) + extended + source.slice(end);

  // No test needs to change: the field cannot alter how any existing fixture
  // decodes, so the referencing tests and the wire-contract classes suffice.
  const history = syntheticGeneratedSwiftHead(t, syntheticHeadSource, undefined, syntheticBaseSource);
  const main = runSelector({ changedFiles, lane: 'main', ...history });
  const evidence = runSelector({ changedFiles, lane: 'evidence', ...history });
  assert.equal(main.mode, 'affected');
  assert.match(main.stdout,
    /generated models narrowed to referencing and wire-contract tests: ChatTypes\.generated\.swift: additive \(optional fields ChatHistoryMessage\.conversationId\)/);
  const selected = selectedTests(main);
  for (const contract of [
    'example-iosTests/ChatHistoryMessageContractTests',
    'example-iosTests/ChatPayloadTypeTests',
    'example-iosTests/ChatHistoryServicePrivacyTests',
  ]) {
    assert.ok(selected.includes(contract), `${contract} must be selected`);
  }
  assert.ok(!selected.includes('example-iosTests/BudgetModelsTests'), 'unrelated classes stay out');
  assert.equal(evidence.should_run, 'false');
  assert.equal(evidence.evidence_groups, '');

  // Dropping the init plumbing, or adding the field as required, is not additive.
  const withoutPlumbing = source.slice(0, start)
    + extended.replace('        self.conversationId = conversationId\n', '')
    + source.slice(end);
  assertFullEscalation(
    runSelector({ changedFiles, lane: 'main', ...syntheticGeneratedSwiftHead(t, withoutPlumbing, undefined, syntheticBaseSource) }),
    /ChatTypes\.generated\.swift: not additive: ChatHistoryMessage\.conversationId lacks its memberwise init plumbing/);
  const required = source.slice(0, start)
    + extended
      .replace('    public var conversationId: String?\n', '    public var conversationId: String\n')
      .replace('        conversationId: String? = nil,\n', '        conversationId: String,\n')
    + source.slice(end);
  assertFullEscalation(
    runSelector({ changedFiles, lane: 'main', ...syntheticGeneratedSwiftHead(t, required, undefined, syntheticBaseSource) }),
    /ChatTypes\.generated\.swift: not additive: ChatHistoryMessage gained a non-optional member: public var conversationId: String$/m);
});

test('an added string enum case narrows to the tests that name the enum', (t) => {
  const changedFiles = 'ios/example-ios/Models/Generated/PlaidAccountTypes.generated.swift';
  const source = fs.readFileSync(path.join(repoRoot, changedFiles), 'utf8');
  const anchor = '    case brokerage = "brokerage"\n    case other = "other"\n}';
  assert.equal(source.split(anchor).length - 1, 1, 'PlaidAccountType ends with brokerage, other');
  const added = source.replace(anchor, '    case brokerage = "brokerage"\n    case other = "other"\n    case sandbox = "sandbox"\n}');
  const history = syntheticGeneratedSwiftHead(t, added, undefined, source, changedFiles);
  const main = runSelector({ changedFiles, lane: 'main', ...history });
  assert.equal(main.mode, 'affected');
  assert.match(main.stdout, /PlaidAccountTypes\.generated\.swift: additive \(enum cases PlaidAccountType\.sandbox\)/);
  const selected = selectedTests(main);
  assert.ok(selected.includes('example-iosTests/NextCardActivationResolverTests'), 'a test naming PlaidAccountType is selected');
  assert.ok(!selected.includes('example-iosTests/ChatPayloadTypeTests'), 'no wire-contract class is registered for this file');

  // Moving existing cases changes allCases order, which untyped consumers observe, so it runs everything.
  const reordered = source.replace(anchor, '    case other = "other"\n    case brokerage = "brokerage"\n    case sandbox = "sandbox"\n}');
  assertFullEscalation(
    runSelector({ changedFiles, lane: 'main', ...syntheticGeneratedSwiftHead(t, reordered, undefined, source, changedFiles) }),
    /PlaidAccountTypes\.generated\.swift: not additive: PlaidAccountType cases were reordered, which changes allCases order/);

  // A removed case, a renamed raw value, or a case without a raw value is not.
  const removed = source.replace('    case brokerage = "brokerage"\n    case other = "other"\n}', '    case other = "other"\n}');
  assertFullEscalation(
    runSelector({ changedFiles, lane: 'main', ...syntheticGeneratedSwiftHead(t, removed, undefined, source, changedFiles) }),
    /PlaidAccountTypes\.generated\.swift: not additive: PlaidAccountType lost a line: case brokerage = "brokerage"/);
  const renamedRaw = source.replace('    case other = "other"\n}', '    case other = "other_account"\n}');
  assertFullEscalation(
    runSelector({ changedFiles, lane: 'main', ...syntheticGeneratedSwiftHead(t, renamedRaw, undefined, source, changedFiles) }),
    /PlaidAccountTypes\.generated\.swift: not additive: PlaidAccountType lost a line: case other = "other"/);
  const rawless = source.replace(anchor, '    case brokerage = "brokerage"\n    case other = "other"\n    case sandbox\n}');
  assertFullEscalation(
    runSelector({ changedFiles, lane: 'main', ...syntheticGeneratedSwiftHead(t, rawless, undefined, source, changedFiles) }),
    /PlaidAccountTypes\.generated\.swift: not additive: PlaidAccountType gained a line that is not a new case: case sandbox/);
});

test('generated Swift documentation edits do not require native tests', (t) => {
  const changedFiles = 'ios/example-ios/Models/Generated/UserProfileTypes.generated.swift';
  const source = fs.readFileSync(path.join(repoRoot, changedFiles), 'utf8');
  const changed = source.replace(
    '/// Approximate typical monthly payment. The required payment is minimumPayment.',
    '/// Approximate monthly payment for display.',
  );
  assert.notEqual(changed, source);
  const history = syntheticGeneratedSwiftHead(t, changed, undefined, source, changedFiles);
  const selection = runSelector({ changedFiles, lane: 'main', ...history });
  assert.equal(selection.mode, 'skip');
  assert.equal(selection.test_count, '0');
  const changedCode = changed.replace(
    '    public var approxMonthlyPayment: Double?',
    '    public var approxMonthlyPayment: String?',
  );
  const unsafeHistory = syntheticGeneratedSwiftHead(t, changedCode, undefined, source, changedFiles);
  assertFullEscalation(runSelector({ changedFiles, lane: 'main', ...unsafeHistory }),
    /UserProfileTypes\.generated\.swift: not additive: \w+ lost a line: public var approxMonthlyPayment: Double\?/);
});

test('unknown or removed generated chat types escalate to the full native suite', (t) => {
  const changedFiles = 'ios/example-ios/Models/Generated/ChatTypes.generated.swift';
  const source = fs.readFileSync(path.join(repoRoot, changedFiles), 'utf8');
  const unknown = source.replace(
    'public struct ChatInfoBubble: Codable, Sendable {',
    'public struct ChatInfoBubble: Codable, Sendable {\n    // New unmapped field.',
  );
  const start = source.indexOf('public struct ChatHistoryMessage:');
  const end = source.indexOf('\npublic struct ChatHistoryBubble:', start);
  assert.ok(unknown !== source && start >= 0 && end > start);
  const removed = source.slice(0, start) + source.slice(end);
  const outsideDeclaration = source.replace('import Foundation', 'import Foundation\nimport Combine');

  for (const [altered, detail] of [
    [unknown, /ChatInfoBubble gained a non-optional member: \/\/ New unmapped field\./],
    [removed, /removed declaration struct:ChatHistoryMessage/],
    [outsideDeclaration, /code outside the top-level declarations changed/],
  ] as const) {
    const history = syntheticGeneratedSwiftHead(t, altered);
    const selection = runSelector({ changedFiles, lane: 'main', ...history });
    assertFullEscalation(selection, /ChatTypes\.generated\.swift: not additive: /);
    assert.match(selection.stepSummary, detail);
  }
  assertFullEscalation(runSelector({ changedFiles, lane: 'main' }),
    /exact base and head are required for generated type ownership/);
});

test('a new generated enum with its optional field narrows to referencing and wire-contract tests', (t) => {
  const changedFiles = 'ios/example-ios/Models/Generated/ChatPayloads.generated.swift';
  const generated = fs.readFileSync(path.join(repoRoot, changedFiles), 'utf8');
  const previous = generated
    .replace(/public enum DebtGoalSeekReasonCode: String, Codable, CaseIterable, Sendable \{\n(?: {4}case [^\n]+\n)+\}\n\n/, '')
    .replace('    public var reasonCode: DebtGoalSeekReasonCode?\n', '');
  assert.notEqual(previous, generated);

  const history = syntheticGeneratedSwiftHead(t, generated, undefined, previous, changedFiles);
  const selection = runSelector({ changedFiles, lane: 'main', ...history });
  assert.equal(selection.mode, 'affected');
  assert.match(selection.stdout,
    /ChatPayloads\.generated\.swift: additive \(optional fields DebtGoalSeekResultPayload\.reasonCode; new types DebtGoalSeekReasonCode\)/);
  const selected = selectedTests(selection);
  assert.ok(selected.includes('example-iosTests/ChatPayloadTypeTests'), 'the wire-contract class runs');
  assert.ok(selected.every((identifier) => !identifier.startsWith('example-iosTests/Budget')),
    'classes that name none of the touched types stay out');

  // The same head with an existing field retyped alongside is not additive.
  const retyped = generated.replace('    public var achievable: Bool\n', '    public var achievable: String\n');
  assert.notEqual(retyped, generated);
  assertFullEscalation(
    runSelector({ changedFiles, lane: 'main', ...syntheticGeneratedSwiftHead(t, retyped, undefined, previous, changedFiles) }),
    /ChatPayloads\.generated\.swift: not additive: DebtGoalSeekResultPayload lost a line: public var achievable: Bool/);
});

const chatTypesPath = 'ios/example-ios/Models/Generated/ChatTypes.generated.swift';
/**
 * The #6019 shape: a previously required generated field becomes optional.
 * The field is located structurally (the first required stored property) so
 * the edit does not depend on which fields the generator currently emits.
 */
const optionalizedRequiredField = (source: string) => {
  const requiredField = /^( {4}public var \w+: [^?{\n]+)$/m;
  assert.match(source, requiredField, 'generated Swift has a required stored property');
  return source.replace(requiredField, '$1?');
};

test('an unprovable generated model change escalates every native lane to the full suite', (t) => {
  const history = syntheticEditedHistory(t, 'head', { [chatTypesPath]: optionalizedRequiredField });
  // A required field that became optional still decodes every old fixture,
  // but callers that unwrapped it change behaviour; that is not an additive edit.
  const unprovable = /ChatTypes\.generated\.swift: not additive: \w+ lost a line: public var \w+: [^?\n]+$/m;
  const main = runSelector({ changedFiles: chatTypesPath, lane: 'main', ...history });
  const evidence = runSelector({ changedFiles: chatTypesPath, lane: 'evidence', ...history });
  assertFullEscalation(main, unprovable);
  assertFullEscalation(evidence, unprovable);
  assert.equal(main.onboarding_required, 'false');
  assert.equal(main.narrow_paywall_required, 'true');
  assert.equal(evidence.evidence_groups, 'accessibility,onboarding-copy,account-update');

  const plan = deriveNativeExecutionPlan({
    selectionMode: 'full',
    selectionRequired: main.should_run === 'true',
    releaseArchiveRequired: main.release_archive_required === 'true',
    onlyTestingIdentifiers: [],
    evidenceGroups: main.evidence_groups.split(','),
    narrowPaywallRequired: main.narrow_paywall_required === 'true',
    forcedLanes: [],
  });
  assert.deepEqual(plan.executionLanes, [
    'native1', 'native2', 'native3', 'native4',
    'evidence-account-update', 'evidence-account-update-2', 'evidence-visual',
  ]);
  assert.equal(plan.releaseArchiveRequired, true);

  // Execution lanes re-run the selector with the gate's `full` mode on the
  // pull-request event; the escalation is re-derived from the same inventory.
  for (const lane of ['main', 'evidence']) {
    assertFullEscalation(runSelector({
      changedFiles: chatTypesPath, lane, mode: 'full', githubEventName: 'pull_request', ...history,
    }), unprovable);
  }
});

test('a vendored LinkKit package change selects the full native suite in every lane', () => {
  const linkKitPackage = 'ios/Packages/PlaidLink/Package.swift';
  for (const lane of ['main', 'evidence']) {
    for (const [mode, githubEventName] of [['affected', 'pull_request'], ['full', 'pull_request']]) {
      const selection = runSelector({ changedFiles: linkKitPackage, lane, mode, githubEventName });
      assert.equal(selection.mode, 'full', `${lane} ${mode}`);
      assert.equal(selection.should_run, 'true');
      assert.equal(selection.only_testing_file, '');
      assert.equal(selection.release_archive_required, 'true');
      assert.match(selection.stepSummary, /escalated to the full native suite/);
      assert.match(selection.stepSummary,
        /Reason: full: linked native dependency changed: ios\/Packages\/PlaidLink\/Package\.swift: /);
    }
  }
});

test('an unprovable generated model does not excuse governance failures in the same change', (t) => {
  const ownerless = 'ios/example-ios/Models/SelectorOwnerlessProbe.swift';
  const withSource = syntheticEditedHistory(t, 'head', { [chatTypesPath]: optionalizedRequiredField });
  assert.throws(() => runSelector({
    changedFiles: [chatTypesPath, ownerless].join('\n'), lane: 'main', ...withSource,
  }), /Cannot select iOS tests for ios\/example-ios\/Models\/SelectorOwnerlessProbe\.swift/);

  const onboardingException = /("example-iosOnboardingUITests" target \*\/ = \{\n\t\t\tisa = PBXFileSystemSynchronizedBuildFileExceptionSet;\n\t\t\tmembershipExceptions = \(\n)\t\t\t\t[^\n]+\n/;
  const withProject = syntheticEditedHistory(t, 'base',
    { [projectPath]: (source) => source.replace(onboardingException, '$1') },
    { [chatTypesPath]: optionalizedRequiredField });
  for (const lane of ['main', 'evidence']) {
    assert.throws(() => runSelector({
      changedFiles: [chatTypesPath, projectPath].join('\n'), lane, ...withProject,
    }), /Unowned Xcode project edit in ios\/example-ios\.xcodeproj\/project\.pbxproj/);
  }

  // Every evidence-only entry in today's plans is routed, so an unrouted one
  // needs a workspace whose evidence plan enables a class nothing else runs.
  const evidencePlan = testPlanPath('CI-Evidence');
  const enableUnroutedClass = (source: string) => {
    const anchor = '        "CardAccountUpdateReturnIRAUITests",\n';
    assert.equal(source.split(anchor).length - 1, 1);
    return source.replace(anchor, `${anchor}        "ChatProfileUpdateRealServerE2ETests",\n`);
  };
  const workspace = syntheticWorkspace(t, { [evidencePlan]: enableUnroutedClass });
  const unrouted = /Selected evidence XCTest has no runnable evidence group, equivalent main route or manual-evidence registration: example-iosUITests\/ChatProfileUpdateRealServerE2ETests/;
  const enabledEvidence = syntheticEditedHistory(t, 'head', { [evidencePlan]: enableUnroutedClass });
  assert.throws(() => runSelector({ changedFiles: evidencePlan, lane: 'main', workspace, ...enabledEvidence }),
    unrouted);
  const withEvidence = syntheticEditedHistory(t, 'head',
    { [evidencePlan]: enableUnroutedClass, [chatTypesPath]: optionalizedRequiredField });
  for (const lane of ['main', 'evidence']) {
    assert.throws(() => runSelector({
      changedFiles: [chatTypesPath, evidencePlan].join('\n'), lane, workspace, ...withEvidence,
    }), unrouted);
  }
});

test('a selector rejection a test expects never reaches the test run output', () => {
  // Rerun the test above in its own runner: it expects "Unowned Xcode project
  // edit" twice, and a passing run must not print it where a failed Workflow
  // contracts log would be searched for its cause.
  const { NODE_TEST_CONTEXT: _parentRunner, ...environment } = process.env;
  const run = spawnSync(process.execPath, [
    '--import', path.join(scriptDir, 'hermeticGithubEvent.ts'), '--test',
    '--test-name-pattern', 'does not excuse governance failures', fileURLToPath(import.meta.url),
  ], { cwd: repoRoot, env: environment, encoding: 'utf8', timeout: selectorTimeoutMs * 4 });
  assert.equal(run.status, 0, run.stdout + run.stderr);
  assert.match(run.stdout, /ℹ pass 1\n/);
  assert.doesNotMatch(run.stdout + run.stderr, /Unowned Xcode project edit/);
});

test('the native interaction repair selects only exact affected methods in their current owner lanes', (t) => {
  const changedFiles = [
    'ios/example-iosUITests/CardAccountUpdateReturnUITests.swift',
    'ios/example-iosUITests/TourCopyReviewEvidenceUITests.swift',
  ].join(',');
  const history = syntheticMethodOnlyHistory(t, [
    {
      relativePath: 'ios/example-iosUITests/CardAccountUpdateReturnUITests.swift',
      sourceNeedle: '        if disclosure.label != "Collapse section" {\n',
    },
    {
      relativePath: 'ios/example-iosUITests/TourCopyReviewEvidenceUITests.swift',
      sourceNeedle: '        var stableSince: Date?\n',
    },
  ]);
  const options = {
    changedFiles,
    ...history,
  };
  const main = runSelector({ ...options, lane: 'main' });
  const evidence = runSelector({ ...options, lane: 'evidence' });
  const selected = fs.readFileSync(main.only_testing_file, 'utf8')
    .trim().split(/\r?\n/).sort();

  assert.equal(main.mode, 'affected');
  assert.equal(main.evidence_groups, '');
  assert.deepEqual(selected, [
    'example-iosUITests/CardAccountUpdateReturnOfflineFailureUITests/testHomeOriginOfflineFailurePreservesStagedAccountAndHiddenTabBar',
    'example-iosUITests/TourCopyReviewEvidenceUITests/testCaptureNotReadySuppression',
    'example-iosUITests/TourCopyReviewEvidenceUITests/testCaptureReadySpendingAnswer',
    'example-iosUITests/TourCopyReviewEvidenceUITests/testNetWorthSpotlightPreservesTourSequence',
  ].sort());
  const ownerByMethod = affectedUiOwners(main.only_testing_file, []);
  assert.deepEqual(Object.keys(ownerByMethod).sort(), selected);
  const expectedExecutionLanes = [...new Set([...Object.values(ownerByMethod), 'native4'])].sort();
  assert.equal(evidence.should_run, 'false');
  assert.equal(evidence.test_count, '0');
  assert.equal(evidence.evidence_groups, '');

  const plannerOutput = path.join(
    fs.mkdtempSync(path.join(os.tmpdir(), 'example-ios-planner-')),
    'github-output.txt',
  );
  execFileSync(process.execPath, [typedPlannerPath], {
    cwd: repoRoot,
    env: {
      ...process.env,
      GITHUB_OUTPUT: plannerOutput,
      'INPUT_EVIDENCE-GROUPS': main.evidence_groups,
      'INPUT_FORCED-LANES': '["native4"]',
      'INPUT_NARROW-PAYWALL-REQUIRED': main.narrow_paywall_required,
      'INPUT_ONLY-TESTING-FILE': main.only_testing_file,
      'INPUT_SELECTION-MODE': main.mode,
    },
  });
  const planner = Object.fromEntries(
    fs.readFileSync(plannerOutput, 'utf8').trim().split('\n')
      .map((line) => line.split('=', 2)),
  );
  assert.deepEqual(JSON.parse(planner.execution_lanes), expectedExecutionLanes);
  assert.deepEqual(JSON.parse(planner.ui_method_owners), ownerByMethod);
});

test('Budget About continuation changes retain native settlement and relink regressions', () => {
  for (const changedFiles of [
    'ios/example-ios/UI/Cards/Budget/BudgetAboutView.swift',
    'ios/example-ios/UI/Cards/Budget/BudgetAboutView+ViewModel.swift',
  ]) {
    const selection = runSelector({ changedFiles, lane: 'main' });
    const identifiers = fs.readFileSync(selection.only_testing_file, 'utf8').trim().split(/\r?\n/);
    for (const name of [
      'BudgetAboutActivationSettlementTests',
      'LinkedAccountRouterRetryPersistenceTests',
      'PlaidSelectedSessionHostReconciliationTests',
      'ConnectedAccountsHubLinkFinalizerTests',
    ]) {
      assert.ok(identifiers.includes(`example-iosTests/${name}`), `${changedFiles}: ${name}`);
    }
  }
});

test('a main-only unit test suppresses the evidence lane', () => {
  const changedFiles = 'ios/example-iosTests/ProfilePhotoViewModelTests.swift';
  const main = runSelector({ changedFiles, lane: 'main' });
  const evidence = runSelector({ changedFiles, lane: 'evidence' });

  assert.equal(main.mode, 'affected');
  assert.equal(main.should_run, 'true');
  assert.equal(main.test_count, '1');
  assert.match(
    fs.readFileSync(main.only_testing_file, 'utf8'),
    /^example-iosTests\/ProfilePhotoViewModelTests$/m
  );
  assert.equal(evidence.mode, 'affected');
  assert.equal(evidence.should_run, 'false');
  assert.equal(evidence.test_count, '0');
  assert.equal(evidence.evidence_groups, '');
});

test('method-only FI edits retain the pinned multi-size accessibility evidence once', (t) => {
  const changedPath = 'ios/example-iosTests/FinancialIndependenceEvidenceTests.swift';
  const history = syntheticMethodOnlyHistory(t, changedPath, '                4.5\n');
  const selection = runSelector({
    changedFiles: changedPath,
    lane: 'main',
    ...history,
  });

  assert.equal(selection.mode, 'affected');
  assert.equal(selection.should_run, 'true');
  const identifiers = fs.readFileSync(selection.only_testing_file, 'utf8').trim().split(/\r?\n/);
  assert.deepEqual(identifiers.sort(), [
    'example-iosTests/FinancialIndependenceEvidenceTests/testStatusChipBackgroundsMeetNormalTextContrast',
    'example-iosUITests/TourCopyReviewEvidenceUITests/testCaptureFinancialIndependenceAccessibilityHierarchy',
  ].sort());
  assert.equal(new Set(identifiers).size, identifiers.length, 'pinned identifiers must be deduplicated');

  const classifyOutput = path.join(
    fs.mkdtempSync(path.join(os.tmpdir(), 'example-ios-fi-classifier-')),
    'github-output.txt',
  );
  execFileSync(process.execPath, [typedPlannerPath], {
    cwd: repoRoot,
    env: {
      ...process.env,
      GITHUB_OUTPUT: classifyOutput,
      'INPUT_EVIDENCE-GROUPS': selection.evidence_groups,
      'INPUT_FORCED-LANES': '[]',
      'INPUT_NARROW-PAYWALL-REQUIRED': selection.narrow_paywall_required,
      'INPUT_ONLY-TESTING-FILE': selection.only_testing_file,
      'INPUT_SELECTION-MODE': selection.mode,
      'INPUT_SELECTION-REQUIRED': 'true',
    },
  });
  const classifier = Object.fromEntries(
    fs.readFileSync(classifyOutput, 'utf8').trim().split('\n')
      .map((line) => line.split('=', 2)),
  );
  assert.deepEqual(JSON.parse(classifier.execution_lanes), ['native1']);

  const plannerOutput = path.join(
    fs.mkdtempSync(path.join(os.tmpdir(), 'example-ios-fi-planner-')),
    'github-output.txt',
  );
  execFileSync(process.execPath, [typedPlannerPath], {
    cwd: repoRoot,
    env: {
      ...process.env,
      GITHUB_OUTPUT: plannerOutput,
      'INPUT_EVIDENCE-GROUPS': selection.evidence_groups,
      'INPUT_FORCED-LANES': '[]',
      'INPUT_NARROW-PAYWALL-REQUIRED': selection.narrow_paywall_required,
      'INPUT_ONLY-TESTING-FILE': selection.only_testing_file,
      'INPUT_SELECTION-MODE': selection.mode,
    },
  });
  const planner = Object.fromEntries(
    fs.readFileSync(plannerOutput, 'utf8').trim().split('\n')
      .map((line) => line.split('=', 2)),
  );
  assert.deepEqual(JSON.parse(planner.execution_lanes), ['native1']);
});

test('paywall legal footer regression runs on the develop PR lane', () => {
  const changedFiles = 'ios/example-iosUITests/PaywallLegalFooterUITests.swift';
  const main = runSelector({ changedFiles, lane: 'main' });

  assert.equal(main.mode, 'affected');
  assert.equal(main.should_run, 'true');
  assert.equal(main.test_count, '1');
  assert.match(
    fs.readFileSync(main.only_testing_file, 'utf8'),
    /^example-iosUITests\/PaywallLegalFooterUITests$/m
  );
});

test('a visual-only evidence test does not schedule the required evidence lane', () => {
  const selection = runSelector({
    changedFiles: 'ios/example-iosUITests/DebtCardLayoutUITests.swift',
    lane: 'evidence',
  });

  assert.equal(selection.mode, 'affected');
  assert.equal(selection.should_run, 'false');
  assert.equal(selection.evidence_groups, '');
});

test('a manually captured evidence XCTest does not schedule an evidence lane', () => {
  const selection = runSelector({
    changedFiles: 'ios/example-iosUITests/ToggleMigrationEvidenceUITests.swift',
    lane: 'evidence',
  });
  assert.equal(selection.mode, 'affected');
  assert.equal(selection.should_run, 'false');
  assert.equal(selection.evidence_groups, '');
});

test('a manually captured evidence XCTest does not schedule an evidence lane', () => {
  const selection = runSelector({
    changedFiles: 'ios/example-iosUITests/ToggleMigrationEvidenceUITests.swift',
    lane: 'evidence',
  });
  assert.equal(selection.mode, 'affected');
  assert.equal(selection.should_run, 'false');
  assert.equal(selection.evidence_groups, '');
});

test('onboarding copy accessibility evidence schedules its owned evidence group', () => {
  const evidence = runSelector({
    changedFiles: 'ios/example-iosUITests/OnboardingCopyAccessibilityEvidenceUITests.swift',
    lane: 'evidence',
  });
  const main = runSelector({
    changedFiles: 'ios/example-iosUITests/OnboardingCopyAccessibilityEvidenceUITests.swift',
    lane: 'main',
  });

  assert.equal(evidence.mode, 'affected');
  assert.equal(evidence.should_run, 'true');
  assert.equal(evidence.test_count, '1');
  assert.equal(evidence.evidence_groups, 'onboarding-copy');
  assert.match(
    fs.readFileSync(evidence.only_testing_file, 'utf8'),
    /^example-iosUITests\/OnboardingCopyAccessibilityEvidenceUITests\/testCaptureOnboardingCopyAccessibilityMatrix\(\)$/m
  );
  assert.equal(main.mode, 'affected');
  assert.equal(main.should_run, 'true');
  assert.equal(main.test_count, '0');
  assert.equal(main.evidence_groups, 'onboarding-copy');
  assert.equal(fs.readFileSync(main.only_testing_file, 'utf8'), '\n');
});

test('account-update evidence schedules its owned main execution group', () => {
  const selection = runSelector({
    changedFiles: 'ios/example-iosUITests/CardAccountUpdateReturnUITests.swift',
    lane: 'main',
  });
  const selected = fs.readFileSync(selection.only_testing_file, 'utf8')
    .trim()
    .split(/\r?\n/)
    .filter(Boolean);

  assert.equal(selection.mode, 'affected');
  assert.equal(selection.should_run, 'true');
  assert.equal(selection.test_count, '0');
  assert.equal(selection.evidence_groups, 'account-update');
  assert.equal(selection.account_update_test_count, '17');
  assert.ok(selected.length > 0);
  assert.ok(selected.every((identifier) =>
    identifier.startsWith('example-iosUITests/CardAccountUpdateReturn')
  ));

  const outputPath = path.join(
    fs.mkdtempSync(path.join(os.tmpdir(), 'example-ios-account-update-plan-')),
    'github-output.txt'
  );
  execFileSync(process.execPath, [typedPlannerPath], {
    cwd: repoRoot,
    env: {
      ...process.env,
      GITHUB_OUTPUT: outputPath,
      'INPUT_EVIDENCE-GROUPS': selection.evidence_groups,
      'INPUT_FORCED-LANES': '[]',
      'INPUT_NARROW-PAYWALL-REQUIRED': selection.narrow_paywall_required,
      'INPUT_ONLY-TESTING-FILE': selection.only_testing_file,
      'INPUT_SELECTION-MODE': selection.mode,
      'INPUT_SELECTION-REQUIRED': 'true',
    },
  });
  const plan = Object.fromEntries(
    fs.readFileSync(outputPath, 'utf8').trim().split('\n')
      .map((line) => line.split('=', 2)),
  );
  assert.deepEqual(JSON.parse(plan.execution_lanes), [
    'evidence-account-update', 'evidence-account-update-2',
  ]);
});

test('account-update evidence removes duplicate selectors but retains unrelated main tests', () => {
  const selection = runSelector({
    changedFiles: [
      'ios/example-iosUITests/CardAccountUpdateReturnUITests.swift',
      'ios/example-iosUITests/PaywallLegalFooterUITests.swift',
    ].join(','),
    lane: 'main',
  });

  const selected = fs.readFileSync(selection.only_testing_file, 'utf8');
  assert.equal(selection.evidence_groups, 'account-update');
  assert.equal(selection.test_count, '1');
  assert.match(selected, /^example-iosUITests\/PaywallLegalFooterUITests$/m);
  assert.match(selected, /^example-iosUITests\/CardAccountUpdateReturn/m);
});

test('mixed account-update evidence transfers an exact main-owned method without dropping it', (t) => {
  const changedFiles = [
    'ios/example-iosUITests/CardAccountUpdateReturnUITests.swift',
    'ios/example-iosUITests/ActivationIntroManageAccountsReturnUITests.swift',
  ].join(',');
  const history = syntheticMethodOnlyHistory(t, [
    {
      relativePath: 'ios/example-iosUITests/CardAccountUpdateReturnUITests.swift',
      sourceNeedle: '        if disclosure.label != "Collapse section" {\n',
    },
    {
      relativePath: 'ios/example-iosUITests/ActivationIntroManageAccountsReturnUITests.swift',
      sourceNeedle: 'class ActivationIntroManageAccountsReturnUITestCase: BaseUITestCase {\n',
    },
  ]);
  const selection = runSelector({
    changedFiles,
    lane: 'main',
    ...history,
  });
  const selected = fs.readFileSync(selection.only_testing_file, 'utf8');

  assert.equal(selection.evidence_groups, 'account-update');
  assert.equal(selection.account_update_test_count, '5');
  assert.match(
    selected,
    /^example-iosUITests\/CardAccountUpdateReturnOfflineFailureUITests\/testHomeOriginOfflineFailurePreservesStagedAccountAndHiddenTabBar$/m,
  );
  assert.match(selected, /^example-iosUITests\/ActivationIntroManageAccounts/m);
  const identifiers = selected.trim().split('\n');
  const first = accountUpdateShardSelection('affected', identifiers, 'evidence-account-update');
  const second = accountUpdateShardSelection('affected', identifiers, 'evidence-account-update-2');
  assert.ok(first);
  assert.ok(second);
  assert.ok(first.identifiers.includes(
    'example-iosUITests/CardAccountUpdateReturnOfflineFailureUITests/testHomeOriginOfflineFailurePreservesStagedAccountAndHiddenTabBar',
  ));
  assert.equal(second.identifiers.some((identifier) => identifier.includes('OfflineFailureUITests')), false);
  assert.equal(first.expectedTestCount + second.expectedTestCount, 5);
});

test('account-update evidence shards consume the main selector transfer', () => {
  const selector = testIosExecution.config.steps.find(
    (step) => step.config.name === 'Determine Affected iOS Tests',
  );
  assert.ok(selector);
  const lane = selector.config.env?.IOS_AFFECTED_TESTS_LANE;
  assert.ok(lane instanceof ExpressionValue);
  assert.match(lane.expression, /matrix\.lane == 'evidence-account-update'/);
  assert.match(lane.expression, /matrix\.lane == 'evidence-account-update-2'/);
  assert.match(lane.expression, /'evidence' \|\| 'main'/);
});

test('every onboarding copy matrix surface schedules accessibility evidence', () => {
  const changedFiles = [
    'ios/example-ios/Core/Content/SmartCardCapabilityCopy.swift',
    'ios/example-ios/UI/Authentication/Components/AuthPrimitives.swift',
    'ios/example-ios/UI/Components/ManualAccountEditorView.swift',
    'ios/example-ios/UI/Components/UserCardSmall.swift',
    'ios/example-ios/UI/ContentView.swift',
    'ios/example-ios/UI/Onboarding/FlippableSmartCardPreview.swift',
    'ios/example-ios/UI/Onboarding/MeetYourSmartCardsView.swift',
    'ios/example-ios/UI/Onboarding/OnboardingCopyAccessibilityEvidenceFixtureView.swift',
    'ios/example-ios/UI/Onboarding/WelcomeView.swift',
    'ios/example-ios/Services/Cards/CardService.swift',
    'ios/example-ios/ViewModels/User/UserDataViewModel.swift',
  ];

  for (const changedFile of changedFiles) {
    const selection = runSelector({ changedFiles: changedFile, lane: 'main' });
    assert.equal(selection.mode, 'affected', changedFile);
    assert.equal(selection.should_run, 'true', changedFile);
    assert.match(selection.evidence_groups, /(?:^|,)onboarding-copy(?:,|$)/, changedFile);
  }
});

test('a Budget lane test keeps its lane-specific target identifier', () => {
  const selection = runSelector({
    changedFiles: 'ios/example-iosUITests/BudgetScopeGatingUITests.swift',
    lane: 'main',
  });

  assert.equal(selection.mode, 'affected');
  assert.equal(selection.should_run, 'true');
  assert.equal(selection.release_archive_required, 'false');
  assert.equal(selection.test_count, '1');
  assert.match(
    fs.readFileSync(selection.only_testing_file, 'utf8'),
    /^example-iosBudgetDebtUITests\/BudgetScopeGatingUITests$/m
  );
});

test('real-server E2E classes outside CI plans are owned by their separately executed plan', () => {
  // These classes compile into example-iosBudgetDebtUITests next to natively
  // selected UI tests, but only the Budget/Income/Debt-card E2E plans run them.
  for (const changedFiles of [
    'ios/example-iosUITests/ChatProfileUpdateRealServerE2ETests.swift',
    'ios/example-iosUITests/DebtCardFreshnessRealServerE2ETests.swift',
    'ios/example-iosUITests/DebtHistoryRemovalRealServerE2ETests.swift',
  ]) {
    for (const lane of ['main', 'evidence']) {
      const selection = runSelector({ changedFiles, lane });
      assert.equal(selection.mode, 'skip', `${changedFiles} (${lane})`);
      assert.equal(selection.should_run, 'false', `${changedFiles} (${lane})`);
    }
  }

  const mixed = runSelector({
    changedFiles: [
      'ios/example-iosUITests/ChatProfileUpdateRealServerE2ETests.swift',
      'ios/example-iosUITests/BudgetScopeGatingUITests.swift',
    ].join('\n'),
    lane: 'main',
  });
  assert.equal(mixed.mode, 'affected');
  const identifiers = fs.readFileSync(mixed.only_testing_file, 'utf8');
  assert.match(identifiers, /^example-iosBudgetDebtUITests\/BudgetScopeGatingUITests$/m);
  assert.doesNotMatch(identifiers, /ChatProfileUpdateRealServerE2ETests/);
});

test('a real-server plan enable outside the Budget shard selectors stays fail-closed', (t) => {
  // Budget runs its shard selector list, the backend evidence plan runs only on
  // a focused dispatch, and Income runs one fixed class: none would execute these.
  const unshardedBudgetClass = syntheticEditedHistory(t, 'head', {
    [testPlanPath('Budget-E2E')]: (source) => source.replace(
      '        "DebtHistoryRemovalRealServerE2ETests"\n',
      '        "DebtHistoryRemovalRealServerE2ETests",\n        "UnshardedRealServerE2ETests"\n'),
  });
  const debtEvidenceClass = syntheticEditedHistory(t, 'head', {
    [testPlanPath('Debt-Card-Backend-Evidence')]: (source) => source.replace(
      '        "DebtCardFreshnessRealServerE2ETests"\n',
      '        "DebtCardFreshnessRealServerE2ETests",\n        "DebtHistoryRemovalRealServerE2ETests"\n'),
  });
  // Unskipping a method is owned only when the shards select it or its whole class.
  const unskipped = (method: string) => syntheticEditedHistory(t, 'base', {
    [testPlanPath('Budget-E2E')]: (source) => source.replace(
      '      "target" : {',
      `      "skippedTests" : [\n        "BudgetRealServerE2ETests/${method}()"\n      ],\n      "target" : {`),
  });
  const unshardedMethod = unskipped('testUnshardedBudgetFlow');
  const shardedMethod = unskipped('testDashboardFinancialTruthRangesAndDrilldowns');
  // A selector the shard script only mentions outside its selector lists runs nothing.
  const workspace = syntheticWorkspace(t, {});
  const shardScript = 'scripts/run-ios-budget-e2e-shards.sh';
  fs.mkdirSync(path.join(workspace, 'scripts'));
  fs.writeFileSync(path.join(workspace, shardScript),
    `${fs.readFileSync(path.join(repoRoot, shardScript), 'utf8')}`
    + '# example-iosBudgetDebtUITests/BudgetRealServerE2ETests/testUnshardedBudgetFlow\n');
  for (const lane of ['main', 'evidence']) {
    assert.throws(() => runSelector({
      changedFiles: testPlanPath('Budget-E2E'), lane, workspace, ...unshardedMethod,
    }), /testUnshardedBudgetFlow\(\), which no CI lane plan executes/);
    assert.equal(runSelector({
      changedFiles: testPlanPath('Budget-E2E'), lane, workspace, ...shardedMethod,
    }).mode, 'skip', lane);
  }
  for (const lane of ['main', 'evidence']) {
    assert.throws(() => runSelector({
      changedFiles: testPlanPath('Budget-E2E'), lane, ...unshardedMethod,
    }), /enables example-iosBudgetDebtUITests\/BudgetRealServerE2ETests\/testUnshardedBudgetFlow\(\), which no CI lane plan executes/);
    assert.equal(runSelector({
      changedFiles: testPlanPath('Budget-E2E'), lane, ...shardedMethod,
    }).mode, 'skip', lane);
    assert.throws(() => runSelector({
      changedFiles: testPlanPath('Budget-E2E'), lane, ...unshardedBudgetClass,
    }), /enables example-iosBudgetDebtUITests\/UnshardedRealServerE2ETests, which no CI lane plan executes/);
    assert.throws(() => runSelector({
      changedFiles: testPlanPath('Debt-Card-Backend-Evidence'), lane, ...debtEvidenceClass,
    }), /enables example-iosBudgetDebtUITests\/DebtHistoryRemovalRealServerE2ETests, which no CI lane plan executes/);
  }
});

test('a real-server E2E plan that only enables tests is owned by its separately executed lane', (t) => {
  const budgetPlan = testPlanPath('Budget-E2E');
  const entry = '        "DebtHistoryRemovalRealServerE2ETests"\n';
  const withoutEntry = (source: string) => {
    assert.equal(source.split(entry).length - 1, 1);
    return source.replace(`,\n${entry}`, '\n');
  };
  const enabled = syntheticEditedHistory(t, 'base', { [budgetPlan]: withoutEntry });
  for (const lane of ['main', 'evidence']) {
    const selection = runSelector({ changedFiles: budgetPlan, lane, ...enabled });
    assert.equal(selection.mode, 'skip', lane);
    assert.equal(selection.should_run, 'false', lane);
  }

  const removed = syntheticEditedHistory(t, 'head', { [budgetPlan]: withoutEntry });
  for (const lane of ['main', 'evidence']) {
    assert.throws(() => runSelector({ changedFiles: budgetPlan, lane, ...removed }),
      /Budget-E2E\.xctestplan: Xcode build\/test-plan semantics need an explicit changed-target owner/);
  }
});

test('a new WLC-02 manual plan and its sole scheme reference have an external E2E owner', (t) => {
  const planPath = testPlanPath('WLC02-Live');
  const runnerPath = 'scripts/ios-test-wellness-lifecycle.py';
  const selectedTests = ['Coast', 'MWO'].flatMap((milestone) =>
    ['Pending', 'Confirmed', 'Grace', 'Expired', 'Recovered'].map((state) =>
      `ChatLiveServerE2ETests/test${milestone}${state}Lifecycle()`));
  const plan = JSON.stringify({
    testTargets: [{ target: { name: 'example-iosUITests' }, selectedTests }],
  });
  const changedFiles = [planPath, wellnessSchemePath, runnerPath].join('\n');
  const history = (alterScheme = false, reducedPlan = false) => {
    const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'example-wellness-plan-'));
    t.after(() => fs.rmSync(temporary, { recursive: true, force: true }));
    const objectEnvironment = syntheticObjectEnvironment(temporary);
    const { git, hashBlob } = syntheticGit(temporary, objectEnvironment);
    const base = git(['rev-parse', 'HEAD']);
    git(['read-tree', base]);
    const scheme = fs.readFileSync(path.join(repoRoot, wellnessSchemePath), 'utf8');
    assert.ok(!scheme.includes(wellnessSchemeReference));
    const registeredScheme = scheme.replace('      </TestPlans>', wellnessSchemeReference + '      </TestPlans>');
    assert.notEqual(registeredScheme, scheme);
    const nextScheme = alterScheme
      ? registeredScheme.replace('buildConfiguration = "Debug">', 'buildConfiguration = "Release">')
      : registeredScheme;
    const nextPlan = reducedPlan
      ? JSON.stringify({ testTargets: [{ target: { name: 'example-iosUITests' },
        selectedTests: selectedTests.slice(0, -1) }] })
      : plan;
    const additions: Array<[string, string]> = [
      [planPath, nextPlan],
      [wellnessSchemePath, nextScheme],
      [runnerPath, 'TEST_PLAN = "WLC02-Live"\n'],
    ];
    for (const [relativePath, content] of additions) {
      const blob = hashBlob(content);
      git(['update-index', '--add', '--cacheinfo', `100644,${blob},${relativePath}`]);
    }
    const head = git(['commit-tree', git(['write-tree']), '-p', base, '-m', 'synthetic WLC-02 registration']);
    return { base, head, ...objectEnvironment };
  };
  const registered = history();
  for (const lane of ['main', 'evidence']) {
    const selection = runSelector({ changedFiles, lane, ...registered });
    assert.equal(selection.mode, 'skip');
    assert.equal(selection.should_run, 'false');
  }

  const alteredScheme = history(true);
  assert.throws(() => runSelector({ changedFiles, lane: 'main', ...alteredScheme }),
    /Cannot narrow .*example-ios\.xcscheme/);

  const reducedPlan = history(false, true);
  assert.throws(() => runSelector({ changedFiles, lane: 'main', ...reducedPlan }),
    /Xcode build\/test-plan semantics need an explicit changed-target owner/);
});

test('synchronized onboarding support files require the separately executed onboarding lane', () => {
  for (const changedFiles of [
    'ios/example-iosUITests/BaseUITestCase.swift',
    'ios/example-iosUITests/CardPlaidActivationTestHelpers.swift',
    'ios/example-iosUITests/PageObjects/PlaidLinkPage.swift',
  ]) {
    const selection = runSelector({ changedFiles, lane: 'main' });
    assert.equal(
      selection.onboarding_required,
      'true',
      `${changedFiles} must trigger the onboarding target that compiles it`
    );
  }

  const budgetOnlySupport = runSelector({
    changedFiles: 'ios/example-iosUITests/BudgetBaseUITestCase.swift',
    lane: 'main',
  });
  assert.equal(budgetOnlySupport.onboarding_required, 'false');
});

test('workflow change gate consumes target-derived onboarding requirements', () => {
  // The selector owns onboarding for a target it compiles; the gate raises its
  // own answer to match, and never lowers one the path owners already set.
  // A queue candidate runs it; a pull request into develop defers it.
  const plan = planIosChangeDetection(gateContext, {
    eventName: 'merge_group', baseRef: 'develop',
    changedFiles: 'ios/example-iosUITests/BudgetBaseUITestCase.swift',
    reuseNativeEvidence: 'false',
    forcedIosAuxiliaryRaw: '[]',
  });
  assert.equal(plan.kind, 'needs-selectors');
  assert.equal(plan.onboardingRequired, false);
  const value = (outputs: readonly StepOutput[], key: string) =>
    outputs.find((output) => output.key === key)?.value;
  assert.equal(
    value(completeIosChangeDetection(gateContext, plan, {
      evidenceRequired: false, mainRequired: true, onboardingRequired: true,
    }, 'false'), 'onboarding_required'),
    'true',
  );
  assert.equal(
    value(completeIosChangeDetection(gateContext, plan, {
      evidenceRequired: false, mainRequired: true, onboardingRequired: false,
    }, 'false'), 'onboarding_required'),
    'false',
  );
});

test('a shared test helper executes its synchronized test target without the full suite', () => {
  const selection = runSelector({
    changedFiles: 'ios/example-iosUITests/CardPlaidActivationTestHelpers.swift',
    lane: 'main',
  });

  assert.equal(selection.mode, 'affected');
  assert.equal(selection.should_run, 'true');
  assert.ok(Number(selection.test_count) > 0);
  const identifiers = fs.readFileSync(selection.only_testing_file, 'utf8');
  assert.match(identifiers, /^example-iosUITests\//m);
  assert.doesNotMatch(
    identifiers,
    /CardPlaidActivationTestHelpers/,
    'a shared helper must expand to executable tests rather than a nonexistent helper test class'
  );
});

test('a named shared test helper selects direct consumers without expanding the whole target', () => {
  const selection = runSelector({
    changedFiles: 'ios/example-iosUITests/PageObjects/PlaidLinkPage.swift',
    lane: 'main',
  });

  assert.equal(selection.mode, 'affected');
  assert.equal(selection.should_run, 'true');
  assert.equal(selection.release_archive_required, 'false');
  assert.equal(selection.test_count, '1');
  const identifiers = fs.readFileSync(selection.only_testing_file, 'utf8');
  assert.match(identifiers, /^example-iosTests\/ProfileOnboardingValidationTests$/m);
  assert.doesNotMatch(identifiers, /ActivationIntroManageAccounts/);
  assert.doesNotMatch(identifiers, /BudgetScopeGatingUITests/);
  assert.doesNotMatch(identifiers, /ChatPlaidLinkE2ETests/);
  assert.doesNotMatch(identifiers, /OnboardingFullFlowUITests/);
});

test('PlaidLinkPage keeps onboarding and Chat Plaid E2E routing outside native handoff', () => {
  const shared = classifyIosChangedPaths(['ios/example-iosUITests/PageObjects/PlaidLinkPage.swift']);
  assert.equal(shared.onboardingRequired, true,
    'the shared Plaid page object must retain its onboarding owner');
  assert.equal(shared.chatPlaidRequired, true,
    'the shared Plaid page object must retain its Chat Plaid owner');
});

test('a mapped native test cannot hide an unmapped app source in the same patch', () => {
  assert.throws(() => runSelector({
    changedFiles: [
      '.github/workflows/ios-tests.yml',
      'ios/example-ios/UI/CompletelyUnmappedSurface.swift',
      'ios/example-iosTests/ProfilePhotoViewModelTests.swift',
    ].join('\n'),
    lane: 'main',
  }), /Cannot select iOS tests for ios\/example-ios\/UI\/CompletelyUnmappedSurface.swift/);
});

test('chat visualization copy has an executable native owner', () => {
  const selection = runSelector({
    changedFiles: 'ios/example-ios/UI/Components/ChatVisualizationBubbles.swift',
    lane: 'main',
  });

  assert.equal(selection.mode, 'affected');
  assert.match(
    fs.readFileSync(selection.only_testing_file, 'utf8'),
    /^example-iosTests\/ChatVisualizationBubblesTests$/m,
  );
});

test('signing-only promotion changes skip both XCTest lanes', () => {
  const changedFiles = [
    'ios/fastlane/Fastfile',
    'scripts/tests/workflow-runner-configuration.test.mjs',
  ].join('\n');

  for (const lane of ['main', 'evidence']) {
    const selection = runSelector({ changedFiles, lane });
    assert.equal(selection.mode, 'skip');
    assert.equal(selection.should_run, 'false');
    assert.equal(selection.test_count, '0');
  }
});

test('iOS workflow and harness-only changes skip XCTest execution', () => {
  const changedFiles = [
    '.github/workflows/ios-tests.yml',
    'ci/tests/iosAffectedEvidenceSelection.test.ts',
    'scripts/ios-test-onboarding-e2e.sh',
    'scripts/stop-onboarding-dev-backend.sh',
  ].join('\n');

  for (const lane of ['main', 'evidence']) {
    const selection = runSelector({ changedFiles, lane });
    assert.equal(selection.mode, 'skip');
    assert.equal(selection.should_run, 'false');
    assert.equal(selection.test_count, '0');
  }
});

test('UI shard metadata is owned by workflow contracts, without hiding native changes', () => {
  const metadata = [
    'ios/ci/ui-test-duration-weights.json',
    'ios/ci/ui-test-primary-exclusions.txt',
  ].join('\n');
  for (const lane of ['main', 'evidence']) {
    const selection = runSelector({ changedFiles: metadata, lane });
    assert.equal(selection.mode, 'skip');
    assert.equal(selection.should_run, 'false');
    const mixed = runSelector({
      changedFiles: `${metadata}\nios/example-iosTests/ProfilePhotoViewModelTests.swift`, lane,
    });
    assert.equal(mixed.mode, 'affected');
    if (lane === 'main') {
      assert.equal(mixed.should_run, 'true');
      assert.match(fs.readFileSync(mixed.only_testing_file, 'utf8'), /ProfilePhotoViewModelTests/);
    }
  }
  assert.throws(() => runSelector({
    changedFiles: 'ios/ci/new-selector-input.json', lane: 'main',
  }), /Cannot select iOS tests for ios\/ci\/new-selector-input\.json/);
});

test('CI plan changes require explicit changed-target semantics instead of every test', () => {
  const changedFiles = [
    'ios/example-ios.xcodeproj/xcshareddata/TestPlans/CI.xctestplan',
    'ios/example-ios.xcodeproj/xcshareddata/TestPlans/CI-UI.xctestplan',
    'ios/example-ios.xcodeproj/xcshareddata/TestPlans/CI-Unit.xctestplan',
  ].join('\n');

  for (const lane of ['main', 'evidence']) {
    assert.throws(() => runSelector({ changedFiles, lane }),
      /Xcode build\/test-plan semantics need an explicit changed-target owner/);
  }
});

test('CI plan changes with unrelated base and head history fail closed', (t) => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'example-unrelated-plan-history-'));
  t.after(() => fs.rmSync(temporary, { recursive: true, force: true }));
  const objectEnvironment = syntheticObjectEnvironment(temporary);
  const { git } = syntheticGit(temporary, objectEnvironment);
  const head = git(['rev-parse', 'HEAD']);
  const base = git(['commit-tree', `${head}^{tree}`, '-m', 'unrelated CI plan base']);
  assert.throws(() => git(['merge-base', base, head]));
  for (const lane of ['main', 'evidence']) {
    assert.throws(() => runSelector({
      changedFiles: testPlanPath('CI'), lane, base, head, ...objectEnvironment,
    }), /Xcode build\/test-plan semantics need an explicit changed-target owner/);
  }
});

test('full mode preserves behavioral account acceptance for production promotion', () => {
  const selection = runSelector({
    changedFiles: '',
    lane: 'evidence',
    mode: 'full',
  });

  assert.equal(selection.mode, 'full');
  assert.equal(selection.should_run, 'true');
  assert.equal(selection.evidence_groups, 'accessibility,onboarding-copy,account-update');
  assert.equal(selection.account_update_test_count, '21');
});

test('automatic PR and retry selection cannot request every native lane', () => {
  assert.throws(() => runSelector({
    changedFiles: 'ios/example-iosTests/CanonicalMortgageChatPayloadTests.swift',
    lane: 'main', mode: 'full', githubEventName: 'pull_request',
  }), /Full iOS selection requires an explicit workflow_dispatch event/);
  assert.equal(runSelector({
    changedFiles: 'ios/example-iosTests/CanonicalMortgageChatPayloadTests.swift', lane: 'main',
  }).mode, 'affected');
});

test('paywall changes request the narrow simulator for the main lane', () => {
  const paywall = runSelector({ changedFiles: 'ios/example-ios/UI/PaywallView.swift', lane: 'main' });
  assert.equal(paywall.should_run, 'true');
  assert.equal(paywall.narrow_paywall_required, 'true');
  const identifiers = fs.readFileSync(paywall.only_testing_file, 'utf8');
  assert.match(identifiers, /^example-iosUITests\/SubscriptionCTACopyEvidenceUITests\/testPaywallUsesSharedTrialCTA\(\)$/m);
  assert.match(identifiers, /^example-iosUITests\/SubscriptionCTACopyEvidenceUITests\/testPaywallUsesSubscribeCTAWhenTrialIneligible\(\)$/m);

  const unrelated = runSelector({ changedFiles: 'ios/example-iosTests/DebtDashboardRefreshTests.swift', lane: 'main' });
  assert.equal(unrelated.narrow_paywall_required, 'false');

  const full = runSelector({ changedFiles: 'ios/example-ios/UI/PaywallView.swift', lane: 'main', mode: 'full' });
  assert.equal(full.narrow_paywall_required, 'true');
});

test('typed execution workflow provisions and passes the narrow simulator for paywall evidence', () => {
  const steps = testIosExecution.config.steps;
  const narrow = steps.find((step) => step.config.name === 'Provision narrow iOS Simulator');
  const execute = steps.find((step) => step.config.name === 'Execute Precompiled iOS Tests');
  assert.ok(narrow);
  assert.ok(execute);
  assert.ok(narrow.config.if instanceof ExpressionValue);
  assert.match(narrow.config.if.expression, /steps\.affected-tests\.outputs\.narrow_paywall_required == 'true'/);
  // run-ios-ci-main-tests.sh runs the narrow paywall phase on native1, the lane
  // the main selector's flag reaches, so native1 must get the narrow device.
  assert.match(narrow.config.if.expression,
    /\|\| \(matrix\.lane == 'native1' && !\(matrix\.lane == 'evidence-account-update' \|\| matrix\.lane == 'evidence-account-update-2'\) && steps\.affected-tests\.outputs\.narrow_paywall_required == 'true'\)/);
  assert.equal(execute.config.env?.IOS_NARROW_DESTINATION, narrow.outputs.dest);
  const required = execute.config.env?.IOS_NARROW_PAYWALL_REQUIRED;
  assert.ok(required instanceof ExpressionValue);
  assert.match(required.expression, /!\(matrix\.lane == 'evidence-account-update' \|\| matrix\.lane == 'evidence-account-update-2'\)/);
  assert.match(required.expression, /steps\.affected-tests\.outputs\.narrow_paywall_required == 'true'/);
});

test('each lane provisions its narrow simulator under the name cleanup releases', () => {
  const narrow = testIosExecution.config.steps
    .find((step) => step.config.name === 'Provision narrow iOS Simulator');
  assert.ok(narrow?.config.if instanceof ExpressionValue);
  const purpose = narrow.config.env?.['IOS_CI_LANE'];
  assert.ok(purpose instanceof ExpressionValue);
  const cases = [
    { lane: 'native1', groups: '', narrowPaywall: 'true', expected: 'Main Narrow' },
    { lane: 'native1', groups: 'account-update', narrowPaywall: 'false', expected: 'Evidence Narrow' },
    { lane: 'native1', groups: 'account-update', narrowPaywall: 'true', expected: 'Evidence Narrow' },
    { lane: 'evidence-visual', groups: 'accessibility', narrowPaywall: 'false', expected: 'Evidence Narrow' },
    { lane: 'native2', groups: '', narrowPaywall: 'true', expected: undefined },
  ];
  for (const { lane, groups, narrowPaywall, expected } of cases) {
    const context = {
      matrix: { lane },
      steps: {
        'affected-tests': { outputs: { should_run: 'true', narrow_paywall_required: narrowPaywall } },
        'evidence-shard': { outputs: { evidence_groups: groups } },
      },
    };
    const provisioned: boolean = Boolean(evaluateExpression(narrow.config.if.expression, context));
    assert.equal(provisioned, expected !== undefined, `${lane} ${groups} provisioning`);
    if (expected === undefined) continue;
    const label: string = evaluateExpression(purpose.expression, context) === 'main' ? 'Main' : 'Evidence';
    const cleanup = simulatorCleanupPlan(
      lane.startsWith('evidence-') ? 'evidence' : lane,
      groups === '' ? [] : groups.split(','),
      { primaryUdid: 'PRIMARY', narrowUdid: 'NARROW' },
    );
    assert.ok(cleanup.ok);
    assert.equal(`${label} Narrow`, expected, `${lane} ${groups} provisions ${label} Narrow`);
    assert.equal(cleanup.cleanups.find((entry) => entry.udid === 'NARROW')?.purpose, expected,
      `${lane} ${groups} cleanup`);
  }
});

test('Personal Property and shared empty-state changes retain manual-entry and model regressions', () => {
  for (const changedFiles of [
    'ios/example-ios/UI/Cards/PersonalProperty/PersonalPropertyDashboardView.swift',
    'ios/example-ios/ViewModels/PersonalProperty/PersonalPropertyViewModel.swift',
    'ios/example-ios/UI/Components/CardAccountEmptyStateView.swift',
  ]) {
    const selection = runSelector({ changedFiles, lane: 'main' });
    assert.equal(selection.mode, 'affected');
    assert.equal(selection.should_run, 'true');
    const identifiers = fs.readFileSync(selection.only_testing_file, 'utf8').trim().split('\n');
    for (const required of [
      'example-iosTests/PersonalPropertyFunctionalBugTests',
      'example-iosTests/PersonalPropertyVehicleRemovalTests',
      'example-iosUITests/PersonalPropertyManualEntryUITests',
    ]) {
      assert.ok(identifiers.includes(required), `${changedFiles} must select ${required}`);
      assert.equal(identifiers.filter(identifier => identifier === required).length, 1);
    }
  }
  const unrelated = runSelector({
    changedFiles: 'ios/example-iosTests/DebtDashboardRefreshTests.swift', lane: 'main',
  });
  assert.doesNotMatch(fs.readFileSync(unrelated.only_testing_file, 'utf8'), /PersonalProperty/);
});

test('whole-class selection subsumes pinned methods without duplicate execution', () => {
  const selection = runSelector({
    changedFiles: 'ios/example-iosUITests/ActivationAssignmentReceiptUITests.swift,ios/example-ios/UI/Components/AccountLinkAssignmentSummaryView.swift,ios/example-iosTests/ProfilePhotoViewModelTests.swift',
    lane: 'main',
  });
  const identifiers = fs.readFileSync(selection.only_testing_file, 'utf8').trim().split('\n');
  const parent = 'example-iosUITests/MixedAssignmentReceiptUITests';
  assert.ok(identifiers.includes(parent), 'retain the full changed test class');
  assert.equal(identifiers.filter(identifier => identifier.startsWith(`${parent}/`)).length, 0);
  assert.ok(identifiers.includes('example-iosTests/ProfilePhotoViewModelTests'),
    'preserve separately selected unit coverage');
});

test('workflow-only selection does not read git history or invoke interactive credentials', t => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'example-selector-partial-clone-'));
  t.after(() => fs.rmSync(temporary, { recursive: true, force: true }));
  const gitPath = path.join(temporary, 'git');
  const credentialAttempt = path.join(temporary, 'interactive-credential-attempt');
  const historyAttempt = path.join(temporary, 'history-read');
  fs.writeFileSync(gitPath, `#!${process.execPath}\n
const fs = require('fs');
const args = process.argv.slice(2);
if (args.includes('rev-parse') || args.includes('merge-base')) { console.log('a'.repeat(40)); process.exit(0); }
if (args.includes('show') || args.includes('diff')) {
  fs.writeFileSync(process.env.HISTORY_ATTEMPT, 'missing blob');
  if (!args.includes('credential.helper=') || !args.includes('credential.interactive=never')
    || process.env.GIT_TERMINAL_PROMPT !== '0' || process.env.GCM_INTERACTIVE !== 'Never') {
    fs.writeFileSync(process.env.CREDENTIAL_ATTEMPT, 'would invoke interactive credential manager');
  }
  process.exit(128);
}
process.exit(1);
`, { mode: 0o700 });
  const outputPath = path.join(temporary, 'output');
  execFileSync(process.execPath, [selectorPath], { cwd: repoRoot, encoding: 'utf8', timeout: 5000,
    env: { ...process.env, PATH: `${temporary}${path.delimiter}${process.env.PATH}`,
      CREDENTIAL_ATTEMPT: credentialAttempt, HISTORY_ATTEMPT: historyAttempt,
      GITHUB_OUTPUT: outputPath, GITHUB_ACTIONS: 'true', IOS_AFFECTED_TESTS_BASE: 'a'.repeat(40),
      IOS_AFFECTED_TESTS_BASE_WORKFLOW: '', IOS_AFFECTED_TESTS_HEAD: 'b'.repeat(40),
      IOS_AFFECTED_TESTS_CHANGED_FILES: '.github/workflows/ios-tests.yml',
      IOS_AFFECTED_TESTS_LANE: 'main', IOS_AFFECTED_TESTS_MODE: 'affected' } });
  assert.equal(fs.existsSync(historyAttempt), false, 'workflow-only selection must not read history');
  assert.equal(fs.existsSync(credentialAttempt), false, 'never invoke an interactive credential helper');
  const output = Object.fromEntries(fs.readFileSync(outputPath, 'utf8').trim().split('\n').map(line => line.split(/=(.*)/s).slice(0, 2)));
  assert.equal(output.should_run, 'false');
  assert.equal(output.mode, 'skip');
});

test('the generated Wellness Swift contract selects executable native coverage', () => {
  const selection = runSelector({
    changedFiles: 'ios/example-ios/Models/Generated/DashboardTypes.generated.swift',
    lane: 'main',
  });
  assert.equal(selection.should_run, 'true');
  assert.equal(selection.wellness_required, 'true');
  assert.equal(selection.wellness_test_count, '5');
  const required = fs.readFileSync(selection.wellness_only_testing_file, 'utf8').trim().split('\n');
  assert.equal(required.length, 5);
  assert.ok(required.every(identifier => identifier.split('/').length === 3));
  assert.ok(required.some(identifier => identifier.includes('WellnessLinkedCardEvidenceUITests/')));
  const selected = fs.readFileSync(selection.only_testing_file, 'utf8');
  assert.ok(required.every(identifier => selected.includes(identifier)));
});

test('server Wellness sources and migrations do not allocate a native runner', () => {
  // Native tests run Swift with no backend; these paths cannot change their result.
  for (const changedFiles of [
    'server/services/wellness/wellnessScoreService.ts',
    'server/services/wellness/exampleInsightsService.ts',
    'server/db/schema/wellnessState.ts',
    'server/db/migrations/0023_busy_lockjaw.sql',
    'server/routes/dashboard.yaml',
    'server/services/shared/generated/dashboardTypes.generated.ts',
    'server/persistence/repositories/wellnessStateRepository.ts',
    'server/services/debt/debtService.ts',
  ]) {
    const selection = runSelector({ changedFiles, lane: 'main' });
    assert.equal(selection.should_run, 'false', changedFiles);
    assert.equal(selection.mode, 'skip', changedFiles);
    assert.equal(selection.wellness_required, 'false', changedFiles);
    assert.equal(selection.test_count, '0', changedFiles);
  }
});

test('required Wellness XCTest verification rejects skipped, empty, and failed results', () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'example-wellness-xcresult-'));
  try {
    const result = path.join(temp, 'wellness.xcresult');
    fs.mkdirSync(result);
    const xcrun = path.join(temp, 'xcrun');
    const validator = path.join(repoRoot, 'scripts/validate-xcresult-summary.sh');
    const valid = { totalTestCount: 5, passedTests: 5, failedTests: 0, skippedTests: 0, expectedFailures: 0, result: 'Passed' };
    for (const [summary, succeeds] of [
      [valid, true],
      [{ ...valid, skippedTests: 1, passedTests: 4 }, false],
      [{ ...valid, totalTestCount: 0, passedTests: 0 }, false],
      [{ ...valid, failedTests: 1, passedTests: 4, result: 'Failed' }, false],
    ]) {
      fs.writeFileSync(xcrun, `#!/usr/bin/env node\nprocess.stdout.write(${JSON.stringify(JSON.stringify(summary))});\n`, { mode: 0o700 });
      const execute = () => execFileSync('bash', [validator, result, '5', 'Wellness contract'], {
        env: { ...process.env, PATH: `${temp}:${process.env.PATH}` }, stdio: 'pipe',
      });
      if (succeeds) assert.doesNotThrow(execute);
      else assert.throws(execute);
    }
  } finally { fs.rmSync(temp, { recursive: true, force: true }); }
});

test('registered product-handoff tooling is proven by contracts without selecting unrelated XCTest methods', () => {
  for (const lane of ['main', 'evidence']) {
    const selection = runSelector({ changedFiles: [...REQUIRED_NATIVE_INPUTS, ...RETIRED_TEST_PRODUCT_INPUTS].join('\n'), lane });
    assert.equal(selection.mode, 'skip');
    assert.equal(selection.should_run, 'false');
  }
});


test('registered auxiliary harnesses skip native XCTest while retaining their required E2E owners', () => {
  const harnesses = [...new Set(Object.values(auxiliaryLanePaths).flat()
    .filter((input) => input.startsWith('scripts/')))];
  assert.equal(classifyIosChangedPaths(['scripts/ios-test-budget-regression.sh']).budgetRequired, true);
  for (const lane of ['main', 'evidence']) {
    const selection = runSelector({ changedFiles: harnesses.join('\n'), lane });
    assert.equal(selection.mode, 'skip');
    assert.equal(selection.should_run, 'false');
    assert.throws(() => runSelector({
      changedFiles: 'scripts/ios-test-budget-regression.sh\nscripts/ios-test-unregistered.sh', lane,
    }), /no affected-test rule exists for scripts\/ios-test-unregistered.sh/);
  }
});
