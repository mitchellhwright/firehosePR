import { auxiliaryLanePaths, XCRESULT_SUMMARY_INPUTS } from './iosChangeClassification.ts';
import { isTestProductContractInput } from './testProductInputs.ts';

/**
 * Ownership of non-Swift inputs to native iOS planning. An owner is a proof of
 * which existing check exercises a change, not a request to run every test.
 */
export type IosFileOwner =
  | 'workflow' | 'archive' | 'runtime-config' | 'build-semantics' | 'project' | 'native-dependency'
  | 'unknown';

// Registered auxiliary harnesses are executable infrastructure, rather than
// Swift product inputs. Derive ownership from the lane registry so selecting
// a required E2E lane cannot also fail the native selector for the same harness.
const auxiliaryHarnessFiles: ReadonlySet<string> = new Set(
  Object.values(auxiliaryLanePaths).flat().filter((input) => input.startsWith('scripts/')),
);

const workflowFiles: ReadonlySet<string> = new Set([
  ...XCRESULT_SUMMARY_INPUTS,
  'ci/src/actions/ios/selectXcode.ts',
  'scripts/ios-test.sh',
  'scripts/ios-test.ts',
  'scripts/build-ios-ci-test-products.sh',
  'scripts/manage-ios-build-cache.sh',
  'scripts/prepare-ios-ci-scheme.py',
  'scripts/prepare-ios-plaid-link.sh',
  'scripts/run-ios-ci-main-tests.sh',
  'scripts/run-with-ios-cache-recovery.sh',
  'ci/src/actions/ios/classifyIosBuildRecovery.ts',
  'ci/src/actions/ios/guardIosIncrementalBuild.ts',
  'ci/src/ios/incrementalBuildGuard.ts',
  'ci/src/ios/iosBuildRecovery.ts',
  'scripts/verify-ios-release-archive.sh',
]);

/** The directory owner also covers new files, avoiding one-off filename rules. */
export function iosFileOwner(changedPath: string): IosFileOwner {
  if (isTestProductContractInput(changedPath)) return 'workflow';
  if (auxiliaryHarnessFiles.has(changedPath)
    || workflowFiles.has(changedPath) || changedPath.startsWith('ios/ci_scripts/')) return 'workflow';
  if (changedPath === 'ios/example-ios.xcodeproj/project.pbxproj') return 'project';
  if (changedPath.startsWith('ios/example-ios.xcodeproj/xcshareddata/TestPlans/')
    && changedPath.endsWith('.xctestplan')) return 'build-semantics';
  if (changedPath.startsWith('ios/example-ios.xcodeproj/xcshareddata/xcschemes/')
    && changedPath.endsWith('.xcscheme')) return 'build-semantics';
  if (changedPath === 'ios/Package.swift' || changedPath === 'ios/Package.resolved') return 'build-semantics';
  // A vendored local package (the LinkKit binary framework) links into the app
  // binary every native test launches, so no narrower test set proves it.
  if (changedPath.startsWith('ios/Packages/')) return 'native-dependency';
  if (changedPath === 'ios/example-ios/Info.plist'
    || changedPath.includes('ios/example-ios/Assets.xcassets/LaunchScreenBackground.')
    || changedPath.includes('ios/example-ios/Assets.xcassets/example-logo.')) return 'runtime-config';
  if (changedPath.startsWith('ios/example-ios/Assets.xcassets/')
    || changedPath.startsWith('ios/example-ios/Resources/')
    || changedPath.startsWith('ios/example-ios/Config/')
    || (changedPath.startsWith('ios/example-ios/') && (
      changedPath.endsWith('.entitlements') || changedPath.endsWith('.plist')))) return 'archive';
  return 'unknown';
}

/**
 * A project edit only belongs to the archive owner when its changed lines are
 * version metadata, resource references or the CI warnings-as-errors mapping,
 * which only changes compiler diagnostics and is proven by the native build.
 * Other build settings, phases and target membership need an explicit owner
 * before they can be narrowed safely.
 */
export function projectPatchResources(patch: string): readonly string[] | null {
  const changedLines = patch.split('\n')
    .filter((line) => /^[+-](?![+-])/.test(line))
    .map((line) => line.slice(1).trim())
    .filter(Boolean);
  if (changedLines.length === 0) return null;
  const resourceNames = new Set(changedLines.flatMap((line) =>
    [...line.matchAll(/\/\* ([^*]+) in Resources \*\//g)].map((match) => match[1] ?? '')
  ));
  for (const line of changedLines) {
    if (/^MARKETING_VERSION = [A-Za-z0-9.]+;$/.test(line)
      || /^CURRENT_PROJECT_VERSION = [0-9]+;$/.test(line)
      || line === 'SWIFT_TREAT_WARNINGS_AS_ERRORS = "$(EXAMPLE_CI_SWIFT_WARNINGS_AS_ERRORS)";') continue;
    const entry = line.match(/^[A-F0-9]{24} \/\* ([^*]+) \*\/ ?(.*)$/);
    if (!entry) return null;
    const name = entry[1]?.replace(/ in Resources$/, '');
    const body = entry[2];
    if (!name || !resourceNames.has(name) || !body) return null;
    if (body === ',') continue;
    if (body.startsWith('= {isa = PBXBuildFile; fileRef = ')
      && body.includes(`/* ${name} */; };`)) continue;
    if (body.startsWith('= {isa = PBXFileReference; ')
      && body.includes('sourceTree = ')) continue;
    return null;
  }
  return [...resourceNames].sort();
}

/** A file that a project edit newly excludes from one target of a synchronized test folder. */
export interface TestFolderExclusion {
  readonly folder: string;
  readonly target: string;
  readonly file: string;
}

interface MembershipExceptions {
  readonly folder: string;
  readonly target: string;
  readonly files: ReadonlySet<string>;
}

const exceptionSetPattern =
  /^(\t*)([A-F0-9]{24}) \/\* Exceptions for "([^"]+)" folder in "([^"]+)" target \*\/ = \{\n[\s\S]*?\n\1\};$/gm;
const membershipExceptionsPattern = /^(\t*)membershipExceptions = \(\n([\s\S]*?)^\1\);$/m;

/** Blank each test folder's exception lists so every other project change stays visible. */
function testFolderMembership(project: string, testFolders: ReadonlySet<string>): {
  readonly skeleton: string;
  readonly exceptionSets: ReadonlyMap<string, MembershipExceptions>;
} {
  const exceptionSets = new Map<string, MembershipExceptions>();
  const skeleton = project.replace(exceptionSetPattern,
    (block: string, _indent: string, id: string, folder: string, target: string) => {
      const list = membershipExceptionsPattern.exec(block);
      if (!testFolders.has(folder) || !list) return block;
      exceptionSets.set(id, {
        folder,
        target,
        files: new Set((list[2] ?? '').split('\n')
          .map((line) => line.trim().replace(/,$/, '').replace(/^"(.*)"$/, '$1'))
          .filter(Boolean)),
      });
      return block.replace(list[0], `${list[1] ?? ''}membershipExceptions = ();`);
    });
  return { skeleton, exceptionSets };
}

/** Exclusions a project edit adds and removes, or null when an exception set appears or moves. */
function testFolderExclusionChanges(
  previous: ReadonlyMap<string, MembershipExceptions>,
  current: ReadonlyMap<string, MembershipExceptions>,
): {
  readonly added: readonly TestFolderExclusion[];
  readonly removed: readonly TestFolderExclusion[];
} | null {
  const added: TestFolderExclusion[] = [];
  const removed: TestFolderExclusion[] = [];
  for (const [id, { folder, target, files }] of current) {
    const prior = previous.get(id);
    if (!prior) return null;
    for (const file of files) {
      if (!prior.files.has(file)) added.push({ folder, target, file });
    }
    for (const file of prior.files) {
      if (!files.has(file)) removed.push({ folder, target, file });
    }
  }
  return { added, removed };
}

/** Longest-common-subsequence lengths for every suffix pair, row-major. */
function commonSuffixLengths(before: readonly string[], after: readonly string[]): Uint32Array {
  const width = after.length + 1;
  const lengths = new Uint32Array((before.length + 1) * width);
  for (let row = before.length - 1; row >= 0; row -= 1) {
    for (let column = after.length - 1; column >= 0; column -= 1) {
      lengths[row * width + column] = before[row] === after[column]
        ? (lengths[(row + 1) * width + column + 1] ?? 0) + 1
        : Math.max(lengths[(row + 1) * width + column] ?? 0, lengths[row * width + column + 1] ?? 0);
    }
  }
  return lengths;
}

/**
 * The removed and added lines of an ordered line diff, prefixed `-` and `+` in
 * the shape `projectPatchResources` reads. Order matters: a build setting that
 * moves between configurations is a change, not a no-op.
 */
export function changedLinePatch(before: string, after: string): string {
  const previous = before.split('\n');
  const current = after.split('\n');
  let start = 0;
  while (start < previous.length && start < current.length
    && previous[start] === current[start]) start += 1;
  let previousEnd = previous.length;
  let currentEnd = current.length;
  while (previousEnd > start && currentEnd > start
    && previous[previousEnd - 1] === current[currentEnd - 1]) {
    previousEnd -= 1;
    currentEnd -= 1;
  }
  const removedRegion = previous.slice(start, previousEnd);
  const addedRegion = current.slice(start, currentEnd);
  const lengths = commonSuffixLengths(removedRegion, addedRegion);
  const width = addedRegion.length + 1;
  const lines: string[] = [];
  let row = 0;
  let column = 0;
  while (row < removedRegion.length || column < addedRegion.length) {
    if (row < removedRegion.length && column < addedRegion.length
      && removedRegion[row] === addedRegion[column]) {
      row += 1;
      column += 1;
    } else if (row < removedRegion.length && (column === addedRegion.length
      || (lengths[(row + 1) * width + column] ?? 0) >= (lengths[row * width + column + 1] ?? 0))) {
      lines.push(`-${removedRegion[row] ?? ''}`);
      row += 1;
    } else {
      lines.push(`+${addedRegion[column] ?? ''}`);
      column += 1;
    }
  }
  return lines.join('\n');
}

/** The independently owned parts of one Xcode project edit. */
export interface ProjectEditOwners {
  /** Resources whose references changed; version and warnings-mapping lines add none. */
  readonly resources: readonly string[];
  /** Whether any line outside test-folder membership exceptions changed. */
  readonly projectLinesChanged: boolean;
  /** Files newly excluded from one target of a synchronized test folder. */
  readonly addedExclusions: readonly TestFolderExclusion[];
  /** Files whose exclusion was removed, which adds them back to that target. */
  readonly removedExclusions: readonly TestFolderExclusion[];
}

/**
 * Splits a project edit into the parts each owner proves: test-folder
 * membership exceptions on one side, and on the other every remaining line,
 * which `projectPatchResources` must accept. A promotion carries many merged
 * edits at once, so an edit made of individually owned parts stays owned.
 * Returns null when any part has no owner, including a new or retargeted
 * exception set, or when nothing changed.
 */
export function projectEditOwners(
  before: string,
  after: string,
  testFolders: readonly string[],
): ProjectEditOwners | null {
  const folders = new Set(testFolders);
  const previous = testFolderMembership(before, folders);
  const current = testFolderMembership(after, folders);
  const exclusions = testFolderExclusionChanges(previous.exceptionSets, current.exceptionSets);
  if (!exclusions) return null;
  const projectLinesChanged = previous.skeleton !== current.skeleton;
  let resources: readonly string[] = [];
  if (projectLinesChanged) {
    const skeletonResources = projectPatchResources(changedLinePatch(previous.skeleton, current.skeleton));
    if (!skeletonResources) return null;
    resources = skeletonResources;
  } else if (exclusions.added.length + exclusions.removed.length === 0) {
    return null;
  }
  return {
    resources,
    projectLinesChanged,
    addedExclusions: exclusions.added,
    removedExclusions: exclusions.removed,
  };
}

/** A selector that a test-plan edit newly enables in one XCTest target. */
export interface EnabledTestSelector {
  readonly target: string;
  readonly selector: string;
}

interface PlanTargetSelectors {
  readonly name: string;
  readonly selected: readonly string[] | undefined;
  readonly skipped: readonly string[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function stringList(value: unknown): readonly string[] | null {
  if (!Array.isArray(value)) return null;
  const items: unknown[] = value;
  return items.every((item): item is string => typeof item === 'string') ? items : null;
}

/** Key order alone must not hide or invent a settings change. */
function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) {
    const items: unknown[] = value;
    return `[${items.map((item) => canonicalJson(item)).join(',')}]`;
  }
  if (isRecord(value)) {
    return `{${Object.keys(value).sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

/** Separate a plan's test selectors from everything else it configures. */
function testPlanSelectors(source: string): {
  readonly skeleton: string;
  readonly targets: readonly PlanTargetSelectors[];
} | null {
  let plan: unknown;
  try {
    plan = JSON.parse(source);
  } catch {
    return null;
  }
  if (!isRecord(plan) || !Array.isArray(plan.testTargets)) return null;
  const entries: unknown[] = plan.testTargets;
  const targets: PlanTargetSelectors[] = [];
  const settings: unknown[] = [];
  for (const entry of entries) {
    if (!isRecord(entry) || !isRecord(entry.target) || typeof entry.target.name !== 'string') return null;
    const { selectedTests, skippedTests, ...rest } = entry;
    // No selectedTests list runs the whole target; an absent skip list skips nothing.
    const selected = selectedTests === undefined ? undefined : stringList(selectedTests);
    const skipped = skippedTests === undefined ? [] : stringList(skippedTests);
    if (selected === null || skipped === null) return null;
    targets.push({ name: entry.target.name, selected, skipped });
    settings.push({ ...rest, selectedTests: selected === undefined ? 'all' : 'listed' });
  }
  return { skeleton: canonicalJson({ ...plan, testTargets: settings }), targets };
}

/**
 * A test-plan edit belongs to the tests it enables only when it adds
 * selectedTests entries or removes skippedTests entries. Removed selections,
 * added skips and every other target, option or configuration change still
 * need an explicit owner.
 */
export function testPlanEnabledSelectors(before: string, after: string): readonly EnabledTestSelector[] | null {
  const previous = testPlanSelectors(before);
  const current = testPlanSelectors(after);
  if (!previous || !current || previous.skeleton !== current.skeleton) return null;
  const enabled: EnabledTestSelector[] = [];
  for (const [index, target] of current.targets.entries()) {
    const prior = previous.targets[index];
    if (!prior) return null;
    const priorSelected = new Set(prior.selected ?? []);
    const selected = new Set(target.selected ?? []);
    const skipped = new Set(target.skipped);
    if ([...priorSelected].some((selector) => !selected.has(selector))
      || [...skipped].some((selector) => !prior.skipped.includes(selector))) return null;
    const newlyEnabled = new Set([
      ...[...selected].filter((selector) => !priorSelected.has(selector)),
      ...prior.skipped.filter((selector) => !skipped.has(selector)),
    ]);
    for (const selector of newlyEnabled) enabled.push({ target: target.name, selector });
  }
  return enabled.length > 0 ? enabled : null;
}

/** Accept a direct fixture path or a Bundle lookup through a typed helper. */
export function methodReadsResource(resourceName: string, source: string, methodBody: string): boolean {
  if (methodBody.includes(resourceName)) return true;
  const lastDot = resourceName.lastIndexOf('.');
  if (lastDot <= 0) return false;
  const stem = resourceName.slice(0, lastDot);
  const extension = resourceName.slice(lastDot + 1);
  const directBundleLookup = methodBody.includes(`forResource: "${stem}"`)
    && methodBody.includes(`withExtension: "${extension}"`);
  const helperNames = [...source.matchAll(/\bfunc\s+([A-Za-z_][A-Za-z0-9_]*)\s*\(\s*_\s+name:\s*String/g)]
    .map((match) => match[1])
    .filter((name): name is string => name !== undefined);
  const sharedFixtureHelper = source.includes(`withExtension: "${extension}"`)
    && helperNames.some((name) => methodBody.includes(`${name}("${stem}")`));
  return directBundleLookup || sharedFixtureHelper;
}
