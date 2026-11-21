/**
 * Xcode's flat JSON enumeration is the inventory of executable methods in a
 * compiled `.xctestproducts` bundle. Collect identifiers from the parsed JSON
 * rather than assuming a particular wrapper key across Xcode releases.
 */
export function compiledTestIdentifiers(document: unknown): readonly string[] {
  const found = new Set<string>();
  const walk = (value: unknown): void => {
    if (typeof value === 'string') {
      const identifier = value.replace(/\(\)$/, '');
      if (/^[A-Za-z_][A-Za-z0-9_-]*\/[A-Za-z_][A-Za-z0-9_]*\/test[A-Za-z0-9_]+$/.test(identifier)) {
        found.add(identifier);
      }
      return;
    }
    if (Array.isArray(value)) {
      value.forEach(walk);
      return;
    }
    if (typeof value === 'object' && value !== null) {
      Object.values(value).forEach(walk);
    }
  };
  walk(document);
  return [...found].sort();
}

interface TestPlanTarget {
  readonly target: { readonly name: string };
  readonly selectedTests?: readonly string[];
  readonly skippedTests?: readonly string[];
}

function stringArray(value: unknown): value is readonly string[] {
  return Array.isArray(value) && value.every((item) => typeof item === 'string');
}

export function testPlanSelectors(document: unknown): readonly string[] {
  if (typeof document !== 'object' || document === null || !('testTargets' in document)
    || !Array.isArray(document.testTargets)) {
    throw new Error('Xcode test plan has no testTargets array');
  }
  const selectors: string[] = [];
  for (const candidate of document.testTargets as unknown[]) {
    if (typeof candidate !== 'object' || candidate === null || !('target' in candidate)
      || typeof candidate.target !== 'object' || candidate.target === null
      || !('name' in candidate.target) || typeof candidate.target.name !== 'string') {
      throw new Error('Xcode test plan has an invalid target');
    }
    const target = candidate as TestPlanTarget;
    if (target.selectedTests !== undefined && !stringArray(target.selectedTests)) {
      throw new Error(`Invalid selectedTests for ${target.target.name}`);
    }
    if (target.skippedTests !== undefined && !stringArray(target.skippedTests)) {
      throw new Error(`Invalid skippedTests for ${target.target.name}`);
    }
    for (const selector of target.selectedTests ?? ['']) {
      const qualified = selector === '' ? target.target.name : `${target.target.name}/${selector}`;
      if ((target.skippedTests ?? []).some((skipped) =>
        selector === skipped || selector.startsWith(`${skipped}/`))) continue;
      selectors.push(qualified.replace(/\(\)$/, ''));
    }
  }
  return [...new Set(selectors)].sort();
}

export interface CompiledPlanComparison {
  readonly compiledMethods: number;
  readonly matchedSelectors: number;
  readonly missingSelectors: readonly string[];
}

/** Compare the authored plan with Xcode's unfiltered executable inventory. */
export function compareCompiledPlan(
  planSelectors: readonly string[],
  compiledIdentifiers: readonly string[],
): CompiledPlanComparison {
  const compiled = new Set(compiledIdentifiers);
  const missingSelectors = planSelectors.filter((selector) =>
    !compiled.has(selector) && !compiledIdentifiers.some((identifier) =>
      identifier.startsWith(`${selector}/`)));
  return {
    compiledMethods: compiled.size,
    matchedSelectors: planSelectors.length - missingSelectors.length,
    missingSelectors,
  };
}

/** Enumerate the compiled products without the changed-file selector's filters. */
export function unfilteredEnumerationArguments(input: {
  readonly planName: 'CI' | 'CI-Unit' | 'CI-Evidence';
  readonly productsPath: string;
  readonly destination: string;
  readonly outputPath: string;
}): readonly string[] {
  return [
    'test-without-building',
    '-project', 'example-ios.xcodeproj',
    '-scheme', 'example-ios-CI',
    '-testPlan', input.planName,
    '-destination', input.destination,
    '-testProductsPath', input.productsPath,
    '-disableAutomaticPackageResolution',
    '-enumerate-tests',
    '-test-enumeration-style', 'flat',
    '-test-enumeration-format', 'json',
    '-test-enumeration-output-path', input.outputPath,
  ];
}
