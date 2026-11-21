/**
 * Xcode's flat JSON enumeration is the inventory of executable methods in a
 * compiled `.xctestproducts` bundle. Collect identifiers from the parsed JSON
 * rather than assuming a particular wrapper key across Xcode releases.
 */
export function compiledTestIdentifiers(document) {
    const found = new Set();
    const walk = (value) => {
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
function stringArray(value) {
    return Array.isArray(value) && value.every((item) => typeof item === 'string');
}
export function testPlanSelectors(document) {
    if (typeof document !== 'object' || document === null || !('testTargets' in document)
        || !Array.isArray(document.testTargets)) {
        throw new Error('Xcode test plan has no testTargets array');
    }
    const selectors = [];
    for (const candidate of document.testTargets) {
        if (typeof candidate !== 'object' || candidate === null || !('target' in candidate)
            || typeof candidate.target !== 'object' || candidate.target === null
            || !('name' in candidate.target) || typeof candidate.target.name !== 'string') {
            throw new Error('Xcode test plan has an invalid target');
        }
        const target = candidate;
        if (target.selectedTests !== undefined && !stringArray(target.selectedTests)) {
            throw new Error(`Invalid selectedTests for ${target.target.name}`);
        }
        if (target.skippedTests !== undefined && !stringArray(target.skippedTests)) {
            throw new Error(`Invalid skippedTests for ${target.target.name}`);
        }
        for (const selector of target.selectedTests ?? ['']) {
            const qualified = selector === '' ? target.target.name : `${target.target.name}/${selector}`;
            if ((target.skippedTests ?? []).some((skipped) => selector === skipped || selector.startsWith(`${skipped}/`)))
                continue;
            selectors.push(qualified.replace(/\(\)$/, ''));
        }
    }
    return [...new Set(selectors)].sort();
}
/** Compare the authored plan with Xcode's unfiltered executable inventory. */
export function compareCompiledPlan(planSelectors, compiledIdentifiers) {
    const compiled = new Set(compiledIdentifiers);
    const missingSelectors = planSelectors.filter((selector) => !compiled.has(selector) && !compiledIdentifiers.some((identifier) => identifier.startsWith(`${selector}/`)));
    return {
        compiledMethods: compiled.size,
        matchedSelectors: planSelectors.length - missingSelectors.length,
        missingSelectors,
    };
}
/** Enumerate the compiled products without the changed-file selector's filters. */
export function unfilteredEnumerationArguments(input) {
    return [
        'test-without-building',
        '-project', 'firehosepr-ios.xcodeproj',
        '-scheme', 'firehosepr-ios-CI',
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
