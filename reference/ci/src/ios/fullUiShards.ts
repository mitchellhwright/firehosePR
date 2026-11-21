import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export const fullUiLanes = ['native1', 'native2', 'native3', 'native4'] as const;
export type FullUiLane = typeof fullUiLanes[number];

/** Native1 also runs Budget and narrow evidence, so it receives less ordinary UI work. */
const laneCapacity: Readonly<Record<FullUiLane, number>> = {
  native1: 0.68,
  native2: 1,
  native3: 1,
  native4: 1,
};

/** These methods require StoreKit priming and must share native1's serial simulator. */
export const storeKitUiMethods = [
  'example-iosUITests/SubscriptionCTACopyEvidenceUITests/testPaywallUsesSharedTrialCTA',
  'example-iosUITests/SubscriptionCTACopyEvidenceUITests/testPaywallUsesSubscribeCTAWhenTrialIneligible',
] as const;

export interface WeightedUiTest {
  readonly identifier: string;
  readonly seconds: number;
}

export interface FullUiShardPlan {
  readonly lanes: Readonly<Record<FullUiLane, readonly string[]>>;
  readonly estimatedSeconds: Readonly<Record<FullUiLane, number>>;
}

export type FullUiPartitionMode = 'matrix' | 'combined';

function positiveDuration(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
    ? value : undefined;
}

function durationMap(value: unknown): Readonly<Record<string, number>> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('UI duration hints must be an object');
  }
  const result: Record<string, number> = {};
  for (const [key, duration] of Object.entries(value)) {
    const seconds = positiveDuration(duration);
    if (seconds === undefined) throw new Error(`Invalid UI duration for ${key}`);
    result[key] = seconds;
  }
  return result;
}

interface DurationHints {
  readonly classes: Readonly<Record<string, number>>;
  readonly tests: Readonly<Record<string, number>>;
}

function parseDurationHints(contents: string): DurationHints {
  const raw: unknown = JSON.parse(contents);
  if (typeof raw !== 'object' || raw === null || !('classes' in raw) || !('tests' in raw)) {
    throw new Error('UI duration hints must contain classes and tests');
  }
  return { classes: durationMap(raw.classes), tests: durationMap(raw.tests) };
}

export interface TestTarget {
  readonly selectedTests: readonly string[];
  readonly skippedTests: readonly string[];
}

function stringList(value: unknown, label: string): readonly string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string')) {
    throw new Error(`${label} must be a string array`);
  }
  return value as string[];
}

export function selectedUiTarget(contents: string): TestTarget {
  const target = selectedUiTargets(contents)['example-iosUITests'];
  if (target === undefined) throw new Error('Xcode test plan has no example-iosUITests target');
  return target;
}

/** UI targets in the CI plan may be split into separate XCTest bundles. */
export function selectedUiTargets(contents: string): Readonly<Record<string, TestTarget>> {
  const raw: unknown = JSON.parse(contents);
  if (typeof raw !== 'object' || raw === null || !('testTargets' in raw)
    || !Array.isArray(raw.testTargets)) {
    throw new Error('Xcode test plan must contain testTargets');
  }
  const targets: Record<string, TestTarget> = {};
  for (const candidate of raw.testTargets as unknown[]) {
    if (typeof candidate !== 'object' || candidate === null || !('target' in candidate)
      || typeof candidate.target !== 'object' || candidate.target === null
      || !('name' in candidate.target) || typeof candidate.target.name !== 'string'
      || !candidate.target.name.endsWith('UITests')) continue;
    const name = candidate.target.name;
    if (targets[name] !== undefined) throw new Error(`Duplicate UI target in Xcode test plan: ${name}`);
    if (!('selectedTests' in candidate)) throw new Error('UI target must select tests explicitly');
    targets[name] = {
      selectedTests: stringList(candidate.selectedTests, 'selectedTests'),
      skippedTests: 'skippedTests' in candidate
        ? stringList(candidate.skippedTests, 'skippedTests') : [],
    };
  }
  if (Object.keys(targets).length === 0) throw new Error('Xcode test plan has no UI targets');
  return targets;
}

function swiftFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return swiftFiles(path);
    return entry.isFile() && entry.name.endsWith('.swift') ? [path] : [];
  }).sort();
}

export function discoverUiMethods(sourceRoot: string): Readonly<Record<string, readonly string[]>> {
  const classes: Record<string, Set<string>> = {};
  const classPattern = /(?:final\s+)?class\s+([A-Za-z_][A-Za-z0-9_]*(?:Tests|UITests))\s*:\s*[^{]+\{/g;
  const methodPattern = /\bfunc\s+(test[A-Za-z0-9_]*)\s*\(/g;
  for (const path of swiftFiles(sourceRoot)) {
    const source = readFileSync(path, 'utf8');
    const declarations = [...source.matchAll(classPattern)];
    for (const [index, declaration] of declarations.entries()) {
      const className = declaration[1];
      if (className === undefined || declaration.index === undefined) continue;
      const end = declarations[index + 1]?.index ?? source.length;
      const body = source.slice(declaration.index + declaration[0].length, end);
      const methods = classes[className] ?? new Set<string>();
      for (const match of body.matchAll(methodPattern)) {
        if (match[1] !== undefined) methods.add(match[1]);
      }
      classes[className] = methods;
    }
  }
  return Object.fromEntries(Object.entries(classes)
    .map(([name, methods]) => [name, [...methods].sort()]));
}

export function selectedWeightedUiTests(
  target: TestTarget,
  discovered: Readonly<Record<string, readonly string[]>>,
  hints: DurationHints,
  excludedIdentifiers: readonly string[],
): readonly WeightedUiTest[] {
  const normalize = (value: string): string => value.replace(/\(\)$/, '');
  const skipped = new Set(target.skippedTests.map(normalize));
  const excluded = new Set(excludedIdentifiers.map(normalize));
  const selected = new Map<string, WeightedUiTest>();
  for (const rawIdentifier of target.selectedTests) {
    const identifier = normalize(rawIdentifier);
    const [className, method] = identifier.split('/');
    if (className === undefined || className.length === 0) throw new Error(`Invalid selected UI test: ${identifier}`);
    const methods = discovered[className];
    if (methods === undefined || methods.length === 0) throw new Error(`Cannot discover UI methods for ${className}`);
    if (method !== undefined && !methods.includes(method)) {
      throw new Error(`Selected UI method is absent from source: ${identifier}`);
    }
    const candidates = method === undefined ? methods : [method];
    for (const candidate of candidates) {
      const name = `example-iosUITests/${className}/${candidate}`;
      if (skipped.has(className) || skipped.has(`${className}/${candidate}`)
        || excluded.has(`example-iosUITests/${className}`) || excluded.has(name)) continue;
      const seconds = hints.tests[`${className}/${candidate}`]
        ?? (hints.classes[className] ?? methods.length * 30) / methods.length;
      if (selected.has(name)) throw new Error(`UI method selected twice: ${name}`);
      selected.set(name, { identifier: name, seconds });
    }
  }
  for (const excludedIdentifier of excluded) {
    const parts = excludedIdentifier.split('/');
    if (parts.length === 3 && discovered[parts[1] ?? '']?.includes(parts[2] ?? '') !== true) {
      throw new Error(`Excluded UI method is absent from source: ${excludedIdentifier}`);
    }
  }
  return [...selected.values()];
}

export function planFullUiShards(
  tests: readonly WeightedUiTest[],
  mode: FullUiPartitionMode = 'matrix',
): FullUiShardPlan {
  const activeLanes: readonly FullUiLane[] = mode === 'matrix'
    ? fullUiLanes : ['native2', 'native3', 'native4'];
  if (tests.length < activeLanes.length) throw new Error('Full UI plan needs tests for every lane');
  const lanes: Record<FullUiLane, string[]> = { native1: [], native2: [], native3: [], native4: [] };
  const estimatedSeconds: Record<FullUiLane, number> = { native1: 0, native2: 0, native3: 0, native4: 0 };
  const requiredStoreKit = new Set<string>(storeKitUiMethods);
  const observed = new Set<string>();
  for (const test of tests) {
    if (observed.has(test.identifier)) throw new Error(`UI method selected twice: ${test.identifier}`);
    observed.add(test.identifier);
    if (!Number.isFinite(test.seconds) || test.seconds <= 0) {
      throw new Error(`Invalid UI duration for ${test.identifier}`);
    }
  }
  if (mode === 'matrix') {
    for (const identifier of requiredStoreKit) {
      if (!observed.has(identifier)) throw new Error(`Required StoreKit UI method is absent: ${identifier}`);
    }
  }
  const assign = (test: WeightedUiTest, lane: FullUiLane): void => {
    lanes[lane].push(test.identifier);
    estimatedSeconds[lane] += test.seconds;
  };
  const ordered = [...tests].sort((left, right) => right.seconds - left.seconds
    || (left.identifier < right.identifier ? -1 : left.identifier > right.identifier ? 1 : 0));
  if (mode === 'matrix') {
    for (const test of ordered) {
      if (requiredStoreKit.has(test.identifier)) assign(test, 'native1');
    }
  }
  for (const test of ordered) {
    if (mode === 'matrix' && requiredStoreKit.has(test.identifier)) continue;
    const lane = activeLanes.reduce((best, candidate) =>
      estimatedSeconds[candidate] / laneCapacity[candidate]
        < estimatedSeconds[best] / laneCapacity[best] ? candidate : best);
    assign(test, lane);
  }
  for (const lane of activeLanes) {
    if (lanes[lane].length === 0) throw new Error(`Full UI lane ${lane} is empty`);
    lanes[lane].sort();
  }
  return { lanes, estimatedSeconds };
}

export function writeFullUiShards(
  testPlanPath: string,
  sourceRoot: string,
  durationHintsPath: string,
  exclusionsPath: string,
  outputPaths: readonly string[],
): FullUiShardPlan {
  if (outputPaths.length !== fullUiLanes.length && outputPaths.length !== fullUiLanes.length - 1) {
    throw new Error('Full UI plan needs three or four output paths');
  }
  const target = selectedUiTarget(readFileSync(testPlanPath, 'utf8'));
  const discovered = discoverUiMethods(sourceRoot);
  const hints = parseDurationHints(readFileSync(durationHintsPath, 'utf8'));
  const exclusions = readFileSync(exclusionsPath, 'utf8').split('\n')
    .map((line) => line.trim()).filter(Boolean);
  const tests = selectedWeightedUiTests(target, discovered, hints, exclusions);
  const mode = outputPaths.length === fullUiLanes.length ? 'matrix' : 'combined';
  const plan = planFullUiShards(tests, mode);
  const lanes = mode === 'matrix' ? fullUiLanes : fullUiLanes.slice(1);
  for (const [index, lane] of lanes.entries()) {
    const path = outputPaths[index];
    if (path === undefined) throw new Error(`No output path for ${lane}`);
    writeFileSync(path, `${plan.lanes[lane].join('\n')}\n`, 'utf8');
  }
  return plan;
}
