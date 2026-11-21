import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import {
  cpSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { affectedUiOwners } from '../src/ios/affectedUiOwners.ts';
import { partitionUiTestFiles } from '../src/ios/uiTestPartition.ts';

/**
 * The UI owner lanes the change gate hands to the Mac lanes, and the
 * duration-balanced partition they come from.
 *
 * `fixtures/ui-owner-lanes/cases.json` holds the native test identifiers the
 * real selector chose for recorded pull-request change sets and edge cases,
 * with the exact-method owners and partitions the retired Python selector
 * (`select-ios-ui-owner-lanes.py`, `partition-ios-ci-main-tests.py`) produced
 * for them. `fixtures/ui-owner-lanes/root` is the data they were computed
 * from: the CI test plan, duration hints and exclusions verbatim, and the UI
 * test sources reduced to their class headers and test declarations, kept
 * as `Inventory.swift.fixture` so the repository gains no Swift file. The
 * reduction was checked to partition identically to the full sources, and
 * the TypeScript port was checked against Python on both before the Python
 * was deleted. The synthetic root below records Python's output the same way.
 */

const repositoryRoot = fileURLToPath(new URL('../../', import.meta.url));
const fixtureDirectory = join(repositoryRoot, 'ci/tests/fixtures/ui-owner-lanes');
/** The fixture root, its Swift inventory renamed to `.swift` as the partitioner reads it. */
const dataRoot = mkdtempSync(join(tmpdir(), 'example-ui-owner-root-'));
cpSync(join(fixtureDirectory, 'root'), dataRoot, { recursive: true });
renameSync(
  join(dataRoot, 'ios/example-iosUITests/Inventory.swift.fixture'),
  join(dataRoot, 'ios/example-iosUITests/Inventory.swift'),
);
after(() => { rmSync(dataRoot, { recursive: true, force: true }); });
const testPlan = join(dataRoot, 'ios/example-ios.xcodeproj/xcshareddata/TestPlans/CI.xctestplan');
const durationHints = join(dataRoot, 'ios/ci/ui-test-duration-weights.json');
const exclusions = join(dataRoot, 'ios/ci/ui-test-primary-exclusions.txt');
const sourceRoot = join(dataRoot, 'ios/example-iosUITests');

const laneSchema = z.enum(['native2', 'native3', 'native4']);
const fixtureSchema = z.object({
  partitions: z.array(z.object({
    target: z.string(),
    shards: z.array(z.array(z.string())),
    exclusions: z.boolean(),
  })),
  cases: z.array(z.union([
    z.object({
      name: z.string(),
      changedFiles: z.array(z.string()).optional(),
      mode: z.string().optional(),
      identifiers: z.array(z.string()),
      evidenceGroups: z.array(z.string()),
      pythonExactOwners: z.record(z.string(), laneSchema),
    }),
    z.object({ name: z.string(), changedFiles: z.array(z.string()), selectorRejected: z.string() }),
  ])),
});
const fixture = fixtureSchema.parse(
  JSON.parse(readFileSync(join(fixtureDirectory, 'cases.json'), 'utf8')),
);
const ownerCases = fixture.cases.flatMap((entry) => ('identifiers' in entry ? [entry] : []));

function withIdentifiersFile<T>(identifiers: readonly string[], use: (file: string) => T): T {
  const directory = mkdtempSync(join(tmpdir(), 'example-ui-owner-lanes-'));
  try {
    const file = join(directory, 'identifiers.txt');
    writeFileSync(file, identifiers.map((identifier) => `${identifier}\n`).join(''));
    return use(file);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

/** The owners of exact `TARGET/Class/method` identifiers; bare classes are balanced separately. */
function exactOwners(owners: Readonly<Record<string, string>>): Record<string, string> {
  return Object.fromEntries(Object.entries(owners)
    .filter(([identifier]) => identifier.trim().replace(/\(\)$/, '').split('/').length >= 3));
}

describe('UI owner lanes from recorded selections', () => {
  it('covers real pull requests, affected selections and every edge case', () => {
    const names = fixture.cases.map((entry) => entry.name);
    assert.ok(names.filter((name) => name.startsWith('PR #')).length >= 30);
    assert.ok(ownerCases.filter((entry) => entry.mode === 'affected').length >= 5);
    const edges = ['empty change set', 'docs only', 'project.pbxproj', 'UI test file', 'unowned'];
    for (const edge of edges) {
      assert.ok(names.some((name) => name.includes(edge)), edge);
    }
  });

  for (const entry of ownerCases) {
    it(`matches the recorded owners: ${entry.name}`, () => {
      const owners = withIdentifiersFile(entry.identifiers, (file) =>
        affectedUiOwners(file, entry.evidenceGroups, dataRoot));
      assert.deepEqual(exactOwners(owners), entry.pythonExactOwners);
    });
  }

  for (const recorded of fixture.partitions) {
    it(`matches the recorded ${recorded.shards.length}-way ${recorded.target} partition`, () => {
      const partition = partitionUiTestFiles({
        testPlanPath: testPlan,
        sourceRoot,
        durationHintsPath: durationHints,
        target: recorded.target,
        ...(recorded.exclusions ? { exclusionsPath: exclusions } : {}),
        shardCount: recorded.shards.length,
      });
      assert.deepEqual(partition.shards, recorded.shards);
    });
  }
});

/** A small data root that reaches every weighting, skip, exclusion and discovery rule. */
const syntheticRoot: Readonly<Record<string, string>> = {
  'src/A.swift': [
    'final class AlphaUITests: XCTestCase {',
    '    func testOne() {}',
    '    func testTwo() {}',
    '    func testThree() {}',
    '    éfunc testHidden() {}',
    '}',
    'class BetaUITests: BaseUITestCase {',
    '    func testB1() {}',
    '    func testB1() {}',
    '}',
    'class SkippedUITests: XCTestCase { func testSkipped() {} }',
    '',
  ].join('\n'),
  'src/nested/B.swift': [
    'class AlphaUITests: XCTestCase {',
    '    func testFour() {}',
    '}',
    'class GammaTests: XCTestCase { func testG1() {}  func testG2() {} }',
    '/* subclass DeltaUITests: Legacy { */ func testD1() {}',
    'class EmptyUITests: XCTestCase { }',
    '',
  ].join('\n'),
  'src/NotSwift.txt': 'class IgnoredUITests: XCTestCase { func testIgnored() {} }\n',
  'plan.xctestplan': JSON.stringify({ testTargets: [
    { target: { name: 'otherTarget' }, selectedTests: ['AlphaUITests'] },
    { target: { name: 'example-iosUITests' },
      selectedTests: ['AlphaUITests', 'BetaUITests/testB1()', 'GammaTests', 'DeltaUITests',
        'EmptyUITests', 'SkippedUITests', 'ExcludedUITests', 'AlphaUITests/testTwo',
        'ZetaUITests/testZ', 'EmptyUITests/testGhost', 'SkippedUITests/testSkipped'],
      skippedTests: ['SkippedUITests', 'GammaTests/testG2()'] },
  ] }),
  'hints.json': JSON.stringify({
    classes: { AlphaUITests: 90, BetaUITests: 0, GammaTests: 'slow', EmptyUITests: 40 },
    tests: { 'AlphaUITests/testOne': 50, 'AlphaUITests/testFour': -1, 'DeltaUITests/testD1': 12.5 },
  }),
  'exclusions.txt':
    'example-iosUITests/ExcludedUITests\n\n  example-iosUITests/AlphaUITests/testThree  \n',
};

const alpha = 'example-iosUITests/AlphaUITests';
const beta = 'example-iosUITests/BetaUITests/testB1';
const delta = 'example-iosUITests/DeltaUITests/testD1';
const ghost = 'example-iosUITests/EmptyUITests/testGhost';
const gamma = 'example-iosUITests/GammaTests/testG1';
const zeta = 'example-iosUITests/ZetaUITests/testZ';
/** What the Python partitioner wrote for `syntheticRoot`, by shard count. */
const syntheticPartitions: Readonly<Record<number, { shards: string[][]; seconds: number[] }>> = {
  1: {
    shards: [[
      `${alpha}/testFour`, `${alpha}/testOne`, `${alpha}/testTwo`, `${alpha}/testTwo`,
      beta, delta, ghost, gamma, zeta,
    ]],
    seconds: [282.5],
  },
  2: {
    shards: [
      [`${alpha}/testOne`, `${alpha}/testTwo`, beta, zeta],
      [`${alpha}/testFour`, `${alpha}/testTwo`, delta, ghost, gamma],
    ],
    seconds: [140, 142.5],
  },
  3: {
    shards: [
      [`${alpha}/testOne`, beta, delta],
      [`${alpha}/testTwo`, ghost, zeta],
      [`${alpha}/testFour`, `${alpha}/testTwo`, gamma],
    ],
    seconds: [92.5, 100, 90],
  },
  4: {
    shards: [
      [`${alpha}/testOne`, zeta],
      [ghost, gamma],
      [`${alpha}/testFour`, `${alpha}/testTwo`, delta],
      [`${alpha}/testTwo`, beta],
    ],
    seconds: [80, 70, 72.5, 60],
  },
};

/** Python's two shards for `syntheticRoot` without the exclusion list. */
const syntheticUnexcludedShards = [
  [`${alpha}/testOne`, `${alpha}/testThree`, `${alpha}/testTwo`, delta, gamma],
  [`${alpha}/testFour`, `${alpha}/testTwo`, beta, ghost, zeta],
];

interface SyntheticError {
  readonly name: string;
  readonly files: Readonly<Record<string, string>>;
  readonly target?: string;
  readonly shards?: number;
  readonly message: RegExp;
}

const syntheticErrors: readonly SyntheticError[] = [
  { name: 'more shards than tests', files: {}, shards: 20,
    message: /^Could not discover enough selected UI tests for partitions$/ },
  { name: 'an excluded method absent from a bare class',
    files: { 'exclusions.txt': 'example-iosUITests/AlphaUITests/testMissing\n' },
    message: /^Could not discover excluded methods for AlphaUITests: \['testMissing'\]$/ },
  { name: 'an exclusion for another target',
    files: { 'exclusions.txt': 'otherTarget/AlphaUITests\n' },
    message: /^Invalid excluded test identifier: otherTarget\/AlphaUITests$/ },
  { name: 'an exclusion without a class', files: { 'exclusions.txt': 'example-iosUITests\n' },
    message: /^Invalid excluded test identifier: example-iosUITests$/ },
  { name: 'a target absent from the plan', files: {}, target: 'NoSuchTarget',
    message: /does not contain target NoSuchTarget$/ },
  { name: 'a target without an explicit selection',
    files: {
      'plan.xctestplan': JSON.stringify({ testTargets: [{ target: { name: 'example-iosUITests' } }] }),
    },
    message: /must explicitly select the example-iosUITests tests to partition$/ },
];

function withSyntheticRoot<T>(
  overrides: Readonly<Record<string, string>>,
  use: (root: string) => T,
): T {
  const root = mkdtempSync(join(tmpdir(), 'example-ui-partition-'));
  try {
    for (const [path, contents] of Object.entries({ ...syntheticRoot, ...overrides })) {
      mkdirSync(dirname(join(root, path)), { recursive: true });
      writeFileSync(join(root, path), contents);
    }
    return use(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function syntheticFiles(root: string, target: string, shardCount: number) {
  return {
    testPlanPath: join(root, 'plan.xctestplan'),
    sourceRoot: join(root, 'src'),
    durationHintsPath: join(root, 'hints.json'),
    target,
    exclusionsPath: join(root, 'exclusions.txt'),
    shardCount,
  };
}

describe('UI test partition rules', () => {
  for (const [count, expected] of Object.entries(syntheticPartitions)) {
    it(`partitions the synthetic root into ${count} shard(s) as recorded`, () => {
      withSyntheticRoot({}, (root) => {
        const files = syntheticFiles(root, 'example-iosUITests', Number(count));
        const partition = partitionUiTestFiles(files);
        assert.deepEqual(partition.shards, expected.shards);
        assert.deepEqual(partition.estimatedSeconds, expected.seconds);
        assert.equal(partition.selectedCount, 9);
      });
    });
  }

  for (const error of syntheticErrors) {
    it(`rejects ${error.name}`, () => {
      withSyntheticRoot(error.files, (root) => {
        assert.throws(
          () => partitionUiTestFiles(
            syntheticFiles(root, error.target ?? 'example-iosUITests', error.shards ?? 1),
          ),
          { message: error.message },
        );
      });
    });
  }

  it('writes each shard and a duration summary from the command line, without exclusions', () => {
    withSyntheticRoot({}, (root) => {
      const outputs = [join(root, 'one.txt'), join(root, 'two.txt')];
      const files = syntheticFiles(root, 'example-iosUITests', 2);
      const stdout = execFileSync('node', [
        join(repositoryRoot, 'ci/src/actions/ios/partitionUiTests.ts'),
        files.testPlanPath, files.sourceRoot, files.durationHintsPath, files.target, ...outputs,
      ], { encoding: 'utf8' });
      assert.equal(
        stdout,
        'Native UI estimated durations: 152.5s, 160.0s across 10 selected identifiers\n',
      );
      assert.deepEqual(outputs.map((output) => readFileSync(output, 'utf8')),
        syntheticUnexcludedShards.map((shard) => `${shard.join('\n')}\n`));
    });
  });
});
