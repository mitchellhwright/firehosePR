import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
/**
 * Deterministic, duration-balanced partitions of the UI tests an Xcode test
 * plan selects for one target.
 *
 * Tests are placed heaviest first on the lightest shard. A test's weight is
 * its method hint, else its class hint split evenly over the class's source
 * methods, else 30 seconds per method. Bare classes in the plan expand to
 * their source methods; method identifiers stay as written.
 */
const fallbackSecondsPerTest = 30;
const classPattern = /(?:final\s+)?class\s+([A-Za-z_][A-Za-z0-9_]*(?:Tests|UITests))\s*:\s*[^{]+\{/gu;
/** A word boundary that also treats non-ASCII letters as word characters. */
const methodPattern = /(?<![\p{L}\p{N}_])func\s+(test[A-Za-z0-9_]*)\s*\(/gu;
function swiftFiles(directory) {
    const files = [];
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
        const path = join(directory, entry.name);
        if (entry.isDirectory()) {
            files.push(...swiftFiles(path));
        }
        else if (entry.name.endsWith('.swift')
            && (entry.isFile() || (entry.isSymbolicLink() && statSync(path).isFile()))) {
            files.push(path);
        }
    }
    return files;
}
/** Reads every `.swift` file under `sourceRoot` into a class → methods inventory. */
export function readUiTestSources(sourceRoot) {
    const methods = new Map();
    const weights = new Map();
    for (const path of swiftFiles(sourceRoot)) {
        const source = readFileSync(path, 'utf8');
        const declarations = [...source.matchAll(classPattern)];
        for (const [index, declaration] of declarations.entries()) {
            const className = declaration[1] ?? '';
            const bodyStart = declaration.index + declaration[0].length;
            const bodyEnd = declarations[index + 1]?.index ?? source.length;
            const found = [...source.slice(bodyStart, bodyEnd).matchAll(methodPattern)]
                .map((match) => match[1] ?? '');
            weights.set(className, Math.max(weights.get(className) ?? 0, Math.max(1, found.length)));
            const known = methods.get(className) ?? new Set();
            for (const method of found)
                known.add(method);
            methods.set(className, known);
        }
    }
    return { methods, weights };
}
const testPlanSchema = z.looseObject({
    testTargets: z.array(z.looseObject({
        target: z.looseObject({ name: z.unknown() }).optional(),
        selectedTests: z.unknown().optional(),
        skippedTests: z.array(z.string()).optional(),
    })).optional(),
});
const hintsSchema = z.looseObject({
    classes: z.record(z.string(), z.unknown()).optional(),
    tests: z.record(z.string(), z.unknown()).optional(),
});
function positive(value) {
    return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : undefined;
}
function normalize(identifier) {
    return identifier.endsWith('()') ? identifier.slice(0, -2) : identifier;
}
/** `a/b/c/d` → `['a', 'b', 'c/d']`: at most three parts, the last keeping its slashes. */
function splitExclusion(identifier) {
    const first = identifier.indexOf('/');
    if (first < 0)
        return [identifier];
    const second = identifier.indexOf('/', first + 1);
    if (second < 0)
        return [identifier.slice(0, first), identifier.slice(first + 1)];
    return [
        identifier.slice(0, first), identifier.slice(first + 1, second), identifier.slice(second + 1),
    ];
}
function parseExclusions(target, identifiers) {
    const classes = new Set();
    const methods = new Map();
    for (const identifier of identifiers) {
        const parts = splitExclusion(identifier);
        const [owner, className = '', method] = parts;
        if (parts.length < 2 || owner !== target) {
            throw new Error(`Invalid excluded test identifier: ${identifier}`);
        }
        if (method === undefined) {
            classes.add(className);
        }
        else {
            methods.set(className, (methods.get(className) ?? new Set()).add(method));
        }
    }
    return { classes, methods };
}
function selectedTarget(input) {
    const plan = testPlanSchema.parse(JSON.parse(input.testPlan));
    const target = (plan.testTargets ?? [])
        .find((candidate) => candidate.target?.name === input.target);
    if (target === undefined) {
        throw new Error(`The test plan does not contain target ${input.target}`);
    }
    if (!Array.isArray(target.selectedTests)) {
        throw new Error(`The test plan must explicitly select the ${input.target} tests to partition`);
    }
    return {
        selected: z.array(z.string()).parse(target.selectedTests),
        skipped: new Set((target.skippedTests ?? []).map(normalize)),
    };
}
/** The identifiers one selected entry contributes, before skipped tests are removed. */
function expandSelected(identifier, className, sources, exclusions) {
    const excludedMethods = exclusions.methods.get(className) ?? new Set();
    if (identifier === className) {
        const discovered = sources.methods.get(className) ?? new Set();
        if (discovered.size === 0)
            throw new Error(`No compiled/source inventory for selected class ${className}`);
        const missing = [...excludedMethods].filter((method) => !discovered.has(method)).sort();
        if (missing.length > 0) {
            const listed = missing.map((method) => `'${method}'`).join(', ');
            throw new Error(`Could not discover excluded methods for ${className}: [${listed}]`);
        }
        return [...discovered].filter((method) => !excludedMethods.has(method))
            .map((method) => `${className}/${method}`);
    }
    const slash = identifier.indexOf('/');
    if (slash >= 0 && excludedMethods.has(identifier.slice(slash + 1)))
        return [];
    return [identifier];
}
/** A method hint when one is recorded (even an invalid one), else the class share. */
function methodSeconds(testHints, identifier, classShare) {
    const recorded = Object.hasOwn(testHints, identifier) ? testHints[identifier] : classShare;
    return positive(recorded) ?? fallbackSecondsPerTest;
}
function weightedTests(input) {
    const hints = hintsSchema.parse(JSON.parse(input.durationHints));
    const classHints = hints.classes ?? {};
    const testHints = hints.tests ?? {};
    const { selected, skipped } = selectedTarget(input);
    const exclusions = parseExclusions(input.target, input.exclusions);
    const weighted = [];
    for (const raw of selected) {
        const identifier = normalize(raw);
        const className = identifier.split('/', 1)[0] ?? '';
        if (exclusions.classes.has(className))
            continue;
        if (skipped.has(identifier) || skipped.has(className))
            continue;
        const identifiers = expandSelected(identifier, className, input.sources, exclusions)
            .filter((candidate) => !skipped.has(candidate));
        const sourceTestCount = input.sources.weights.get(className) ?? 1;
        const classHint = Object.hasOwn(classHints, className) ? classHints[className] : undefined;
        const classSeconds = positive(classHint) ?? sourceTestCount * fallbackSecondsPerTest;
        for (const candidate of identifiers) {
            const seconds = candidate.includes('/')
                ? methodSeconds(testHints, candidate, classSeconds / sourceTestCount)
                : positive(classSeconds) ?? fallbackSecondsPerTest;
            weighted.push({ identifier: candidate, seconds });
        }
    }
    return weighted;
}
function lightestShard(estimatedSeconds) {
    let lightest = 0;
    for (const [index, seconds] of estimatedSeconds.entries()) {
        if (seconds < (estimatedSeconds[lightest] ?? 0))
            lightest = index;
    }
    return lightest;
}
/** Partitions the target's selected UI tests into `shardCount` duration-balanced shards. */
export function partitionUiTests(input) {
    if (!Number.isInteger(input.shardCount) || input.shardCount < 1) {
        throw new Error('At least one UI partition output is required');
    }
    const tests = weightedTests(input);
    if (new Set(tests.map(test => test.identifier)).size !== tests.length)
        throw new Error('Selected UI tests contain duplicate identifiers');
    if (tests.length < input.shardCount) {
        throw new Error('Could not discover enough selected UI tests for partitions');
    }
    const shards = Array.from({ length: input.shardCount }, () => []);
    const estimatedSeconds = Array.from({ length: input.shardCount }, () => 0);
    const ordered = [...tests].sort((left, right) => right.seconds - left.seconds
        || (left.identifier < right.identifier ? -1 : left.identifier > right.identifier ? 1 : 0));
    for (const test of ordered) {
        const index = lightestShard(estimatedSeconds);
        shards[index]?.push(`${input.target}/${test.identifier}`);
        estimatedSeconds[index] = (estimatedSeconds[index] ?? 0) + test.seconds;
    }
    return {
        shards: shards.map((shard) => [...shard].sort()),
        estimatedSeconds,
        selectedCount: tests.length,
    };
}
/** Reads the plan, sources, hints and optional exclusion list from disk, then partitions. */
export function partitionUiTestFiles(files) {
    const exclusions = files.exclusionsPath === undefined ? [] : readFileSync(files.exclusionsPath, 'utf8').split(/\r\n|\n|\r/).map((line) => line.trim()).filter(Boolean);
    return partitionUiTests({
        testPlan: readFileSync(files.testPlanPath, 'utf8'),
        durationHints: readFileSync(files.durationHintsPath, 'utf8'),
        sources: readUiTestSources(files.sourceRoot),
        target: files.target,
        exclusions,
        shardCount: files.shardCount,
    });
}
