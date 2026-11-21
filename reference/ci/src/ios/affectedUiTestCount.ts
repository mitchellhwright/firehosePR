import type { TestTarget } from './fullUiShards.ts';

type UiTargets = Readonly<Record<string, TestTarget>>;

function selectorParts(identifier: string, qualified: boolean): readonly [string, string?] {
  const parts = identifier.replace(/\(\)$/, '').split('/');
  if (qualified) {
    if (parts.length !== 2 && parts.length !== 3) {
      throw new Error(`Invalid affected UI selector: ${identifier}`);
    }
    if (parts.length === 2 && identifier.endsWith('()')) {
      throw new Error(`Invalid affected UI class selector: ${identifier}`);
    }
    return [parts[1] ?? '', parts[2]];
  }
  if (parts.length !== 1 && parts.length !== 2) {
    throw new Error(`Invalid UI test plan selector: ${identifier}`);
  }
  if (parts.length === 1 && identifier.endsWith('()')) {
    throw new Error(`Invalid UI test plan class selector: ${identifier}`);
  }
  return [parts[0] ?? '', parts[1]];
}

function matchingMethods(
  identifier: string,
  qualified: boolean,
  targetName: string,
  discovered: Readonly<Record<string, readonly string[]>>,
): readonly string[] {
  const [className, methodName] = selectorParts(identifier, qualified);
  const methods = discovered[className];
  if (methods === undefined || methods.length === 0) {
    throw new Error(`Cannot discover UI methods for ${className}`);
  }
  if (methodName !== undefined && !methods.includes(methodName)) {
    throw new Error(`Selected UI method is absent from source: ${identifier}`);
  }
  return (methodName === undefined ? methods : [methodName])
    .map((method) => `${targetName}/${className}/${method}`);
}

function expand(
  identifiers: readonly string[],
  targetName: string,
  qualified: boolean,
  discovered: Readonly<Record<string, readonly string[]>>,
  rejectDuplicates = false,
): Set<string> {
  const methods = new Set<string>();
  for (const identifier of identifiers) {
    for (const method of matchingMethods(identifier, qualified, targetName, discovered)) {
      if (rejectDuplicates && methods.has(method)) {
        throw new Error(`UI method selected twice: ${method}`);
      }
      methods.add(method);
    }
  }
  return methods;
}

function expandCli(
  identifiers: readonly string[],
  targets: UiTargets,
  discovered: Readonly<Record<string, readonly string[]>>,
  rejectDuplicates = false,
): Set<string> {
  const methods = new Set<string>();
  for (const identifier of identifiers) {
    const targetName = identifier.split('/', 1)[0] ?? '';
    if (targets[targetName] === undefined) {
      throw new Error(`Invalid affected UI selector: ${identifier}`);
    }
    for (const method of expand([identifier], targetName, true, discovered)) {
      if (rejectDuplicates && methods.has(method)) {
        throw new Error(`UI method selected twice: ${method}`);
      }
      methods.add(method);
    }
  }
  return methods;
}

/** Count XCTest methods across every UI target in CI.xctestplan. */
export function countAffectedUiTests(
  onlyTesting: readonly string[],
  skipped: readonly string[],
  targets: UiTargets,
  discovered: Readonly<Record<string, readonly string[]>>,
): number {
  if (onlyTesting.length === 0) throw new Error('Affected UI selection is empty');
  const selectedByPlan = new Set<string>();
  const skippedByPlan = new Set<string>();
  for (const [targetName, target] of Object.entries(targets)) {
    for (const method of expand(target.selectedTests, targetName, false, discovered, true)) {
      selectedByPlan.add(method);
    }
    for (const method of expand(target.skippedTests, targetName, false, discovered)) {
      skippedByPlan.add(method);
    }
  }
  const selectedByCli = expandCli(onlyTesting, targets, discovered, true);
  const skippedByCli = expandCli(skipped, targets, discovered);
  for (const method of selectedByCli) {
    if (!selectedByPlan.has(method) && !skippedByPlan.has(method)
      && !skippedByCli.has(method)) {
      throw new Error(`Affected UI method is absent from the test plan: ${method}`);
    }
  }
  // A bare CLI class may include methods owned by an explicit test-plan or
  // command-line skip. Those exclusions are intentional.
  const expected = [...selectedByCli].filter((identifier) =>
    selectedByPlan.has(identifier) && !skippedByPlan.has(identifier)
      && !skippedByCli.has(identifier));
  if (expected.length === 0) {
    throw new Error('Affected UI selection contains no executable test methods');
  }
  return expected.length;
}
