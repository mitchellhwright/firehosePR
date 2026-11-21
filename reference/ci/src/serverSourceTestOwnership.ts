import { posix } from 'node:path';
import ts from 'typescript';

/** Source files can enter the server test planner only with exact-revision ownership. */
export function isServerDeclaration(path: string): boolean {
  return /^server\/(?!tests\/).+\.d\.ts$/.test(path);
}

export function isServerProductSource(path: string): boolean {
  return /^server\/(?!tests\/|scripts\/).+\.tsx?$/.test(path)
    && !/\.config\.tsx?$/.test(path)
    && !isServerDeclaration(path);
}

function hasOnlyTypeBindings(
  statement: ts.ImportDeclaration | ts.ExportDeclaration,
): boolean {
  if (ts.isImportDeclaration(statement)) {
    const clause = statement.importClause;
    if (clause === undefined) return false;
    if (clause.isTypeOnly) return true;
    const bindings = clause.namedBindings;
    return clause.name === undefined && bindings !== undefined && ts.isNamedImports(bindings)
      && bindings.elements.length > 0 && bindings.elements.every((element) => element.isTypeOnly);
  }
  if (statement.isTypeOnly) return true;
  const clause = statement.exportClause;
  return clause !== undefined && ts.isNamedExports(clause)
    && clause.elements.length > 0 && clause.elements.every((element) => element.isTypeOnly);
}

/** A module with no runtime emit has no behavior for a test to execute; type-check owns it. */
export function isTypeOnlyModule(path: string, source: string): boolean {
  const parsed = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true);
  return parsed.statements.length > 0 && parsed.statements.every((statement) =>
    ts.isInterfaceDeclaration(statement)
    || ts.isTypeAliasDeclaration(statement)
    || ((ts.isImportDeclaration(statement) || ts.isExportDeclaration(statement))
      && hasOnlyTypeBindings(statement)));
}

export interface ServerSourceTestImpact {
  readonly ownedSources: readonly string[];
  readonly affectedUnitTests: readonly string[];
  readonly affectedIntegrationTests: readonly string[];
  readonly totalUnitTests: number;
}

/** These suites require the dedicated, single-worker process-heavy lane. */
export const serverProcessHeavyTests = new Set([
  'server/tests/chatProviderBoundaryManifest.test.ts',
  'server/tests/dateWindowTimezone.test.ts',
]);

function isUnitTest(path: string): boolean {
  return /^server\/tests\/.+\.test\.ts$/.test(path)
    && !path.endsWith('.integration.test.ts')
    // This opt-in benchmark is excluded by the regular server Vitest run.
    && path !== 'server/tests/modelBenchmark.test.ts';
}

function isIntegrationTest(path: string): boolean {
  return /^server\/tests\/.+\.integration\.test\.ts$/.test(path);
}

/** Global source scanners read directories rather than importing each file. */
function isReadByChatService(
  path: string,
  readers: ReadonlyMap<string, ReadonlySet<string>>,
): boolean {
  const seen = new Set([path]);
  const work = [path];
  for (let index = 0; index < work.length; index += 1) {
    for (const reader of readers.get(work[index] ?? '') ?? []) {
      if (reader.startsWith('server/services/chat/')) return true;
      if (seen.has(reader)) continue;
      seen.add(reader);
      work.push(reader);
    }
  }
  return false;
}

function directoryScanOwners(
  path: string,
  baseReaders: ReadonlyMap<string, ReadonlySet<string>>,
  headReaders: ReadonlyMap<string, ReadonlySet<string>>,
): readonly string[] {
  const owners = ['server/tests/stuckSyncPolicy.test.ts'];
  if (path.startsWith('server/services/chat/')
    || isReadByChatService(path, baseReaders)
    || isReadByChatService(path, headReaders)) {
    owners.push('server/tests/chatProviderBoundaryManifest.test.ts');
  }
  if (!path.split('/').some((segment) => [
    'docs', 'generated', 'scripts', 'supabase', 'tests',
  ].includes(segment))) {
    owners.push('server/tests/contributionConsumerInventory.test.ts');
  }
  if (path !== 'server/db/schema/schema.ts' && !path.startsWith('server/db/migrations/')
    && !path.startsWith('server/supabase/') && !path.includes('/docs/')) {
    owners.push('server/tests/debtClassifierSourceGuard.test.ts');
  }
  if (/^server\/(controllers|middleware|platform|routes|services|scripts)\//.test(path)) {
    owners.push('server/tests/gcpPlatformMigration.contract.test.ts');
  }
  return owners;
}

/**
 * Resolve only imports whose target is present in the verified source view,
 * or is a removed source that view still names.
 */
function importedSource(
  from: string,
  specifier: string,
  isTarget: (path: string) => boolean,
): string | undefined {
  if (!specifier.startsWith('.')) return undefined;
  const path = posix.normalize(posix.join(posix.dirname(from), specifier));
  return [
    path, path.replace(/\.jsx?$/, '.tsx'), path.replace(/\.js$/, '.ts'),
    `${path}.ts`, `${path}.tsx`, `${path}/index.ts`, `${path}/index.tsx`,
  ].find(isTarget);
}

const readerCache = new WeakMap<ReadonlyMap<string, string>, ReadonlyMap<string, ReadonlySet<string>>>();

function isSourceReadCall(node: ts.Node): node is ts.CallExpression {
  return ts.isCallExpression(node)
    && (ts.isIdentifier(node.expression)
      && (node.expression.text === 'readFileSync' || node.expression.text === 'readFile')
      || ts.isPropertyAccessExpression(node.expression)
        && (node.expression.name.text === 'readFileSync' || node.expression.name.text === 'readFile'));
}

function containsIdentifier(node: ts.Node, name: string): boolean {
  if (ts.isIdentifier(node) && node.text === name) return true;
  return ts.forEachChild(node, (child) => containsIdentifier(child, name) || undefined) ?? false;
}

/** Follow an immutable local path binding in the enclosing lexical scope. */
function localPathInitializer(reference: ts.Identifier): ts.Expression | undefined {
  for (let scope = reference.parent; scope !== undefined; scope = scope.parent) {
    if (ts.isBlock(scope) || ts.isSourceFile(scope)) {
      for (const statement of scope.statements) {
        if (statement.pos >= reference.pos || !ts.isVariableStatement(statement)
          || !(statement.declarationList.flags & ts.NodeFlags.Const)) continue;
        for (const declaration of statement.declarationList.declarations) {
          if (ts.isIdentifier(declaration.name) && declaration.name.text === reference.text) {
            return declaration.initializer;
          }
        }
      }
    }
    if ((ts.isArrowFunction(scope) || ts.isFunctionDeclaration(scope)
      || ts.isFunctionExpression(scope))
      && scope.parameters.some((parameter) => ts.isIdentifier(parameter.name)
        && parameter.name.text === reference.text)) return undefined;
  }
  return undefined;
}

/** A local helper whose path parameter flows into a file read owns its literal call sites. */
function sourceReadWrappers(parsed: ts.SourceFile): ReadonlySet<string> {
  const wrappers = new Set<string>();
  for (const statement of parsed.statements) {
    const candidates = ts.isFunctionDeclaration(statement) && statement.name !== undefined
      ? [{ name: statement.name.text, parameters: statement.parameters, body: statement.body }]
      : ts.isVariableStatement(statement)
        ? statement.declarationList.declarations.flatMap((declaration) =>
          ts.isIdentifier(declaration.name)
            && declaration.initializer !== undefined
            && (ts.isArrowFunction(declaration.initializer)
              || ts.isFunctionExpression(declaration.initializer))
            ? [{ name: declaration.name.text, parameters: declaration.initializer.parameters,
              body: declaration.initializer.body }]
            : [])
        : [];
    for (const candidate of candidates) {
      const pathParameter = candidate.parameters[0]?.name;
      if (candidate.body === undefined || pathParameter === undefined
        || !ts.isIdentifier(pathParameter)) continue;
      const readsParameter = (node: ts.Node): boolean => {
        if (isSourceReadCall(node) && node.arguments[0] !== undefined
          && containsIdentifier(node.arguments[0], pathParameter.text)) return true;
        return ts.forEachChild(node, (child) => readsParameter(child) || undefined) ?? false;
      };
      if (readsParameter(candidate.body)) wrappers.add(candidate.name);
    }
  }
  return wrappers;
}

function readersOf(
  sources: ReadonlyMap<string, string>,
  removedTargets: ReadonlySet<string> = new Set(),
): ReadonlyMap<string, ReadonlySet<string>> {
  const cacheable = removedTargets.size === 0;
  const cached = cacheable ? readerCache.get(sources) : undefined;
  if (cached !== undefined) return cached;
  const isTarget = (path: string): boolean => sources.has(path) || removedTargets.has(path);
  const readers = new Map<string, Set<string>>();
  for (const [path, source] of sources) {
    if (!/^server\/.+\.tsx?$/.test(path)) continue;
    const parsed = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true);
    const wrappers = sourceReadWrappers(parsed);
    const addReader = (specifier: string): void => {
      const target = specifier.startsWith('server/') && isTarget(specifier)
        ? specifier : importedSource(path, specifier, isTarget);
      if (target === undefined || !target.startsWith('server/')) return;
      const owners = readers.get(target) ?? new Set<string>();
      owners.add(path);
      readers.set(target, owners);
    };
    const inspectSourceReadPath = (candidate: ts.Node, seen = new Set<ts.Node>()): void => {
      if (seen.has(candidate)) return;
      seen.add(candidate);
      if (ts.isStringLiteral(candidate)
        && /^(\.\.?\/|server\/).+\.tsx?$/.test(candidate.text)) addReader(candidate.text);
      if (ts.isIdentifier(candidate)) {
        const initializer = localPathInitializer(candidate);
        if (initializer !== undefined) inspectSourceReadPath(initializer, seen);
      }
      ts.forEachChild(candidate, (child) => inspectSourceReadPath(child, seen));
    };
    for (const statement of parsed.statements) {
      const declaration = ts.isImportDeclaration(statement) || ts.isExportDeclaration(statement)
        ? statement : undefined;
      if (declaration?.moduleSpecifier === undefined
        || !ts.isStringLiteral(declaration.moduleSpecifier)) continue;
      if (ts.isImportDeclaration(declaration)) {
        const clause = declaration.importClause;
        if (clause?.isTypeOnly) continue;
        const bindings = clause?.namedBindings;
        if (clause !== undefined && clause.name === undefined && bindings !== undefined
          && ts.isNamedImports(bindings)
          && bindings.elements.every((element) => element.isTypeOnly)) continue;
      } else if (declaration.isTypeOnly) continue;
      addReader(declaration.moduleSpecifier.text);
    }
    const visit = (node: ts.Node): void => {
      if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) {
        const specifier = node.arguments[0];
        if (specifier !== undefined && ts.isStringLiteral(specifier)) addReader(specifier.text);
      }
      if (ts.isCallExpression(node) && ts.isIdentifier(node.expression)
        && wrappers.has(node.expression.text) && node.arguments[0] !== undefined
      ) inspectSourceReadPath(node.arguments[0]);
      if (isSourceReadCall(node)) {
        const firstArgument = node.arguments[0];
        if (firstArgument !== undefined) inspectSourceReadPath(firstArgument);
      }
      ts.forEachChild(node, visit);
    };
    ts.forEachChild(parsed, visit);
  }
  if (cacheable) readerCache.set(sources, readers);
  return readers;
}

function transitiveTestReaders(
  changedPath: string,
  readers: ReadonlyMap<string, ReadonlySet<string>>,
): readonly string[] {
  const seen = new Set([changedPath]);
  const work = [changedPath];
  const tests = new Set<string>();
  for (let index = 0; index < work.length; index += 1) {
    for (const reader of readers.get(work[index] ?? '') ?? []) {
      if (seen.has(reader)) continue;
      seen.add(reader);
      if (isUnitTest(reader) || isIntegrationTest(reader)) tests.add(reader);
      work.push(reader);
    }
  }
  return [...tests].sort();
}

/**
 * Bind server test selection to Git's trusted-base and exact-PR-head source
 * views. Both graphs matter for a deleted or renamed module. A new source in
 * a known server directory gets an owner through imports automatically; a
 * source with no reachable test fails visibly instead of running every suite.
 * A types-only source emits no runtime code, so it needs no test owner; the
 * type-check gate validates it and directory scanners still read it.
 * A removed source can be absent from both views, as when the trusted base
 * already deleted it: exact-head files that still import it are its readers,
 * and with no reader left there is nothing for a test to execute.
 */
export function deriveServerSourceTestImpact(
  baseSources: ReadonlyMap<string, string>,
  headSources: ReadonlyMap<string, string>,
  changedFiles: readonly string[],
  deletedFiles: readonly string[],
  runnableIntegrationTests: ReadonlySet<string> = new Set(),
): ServerSourceTestImpact {
  const ownedSources = [...new Set([...changedFiles, ...deletedFiles]
    .filter(isServerProductSource))].sort();
  if (ownedSources.length === 0) {
    return {
      ownedSources: [], affectedUnitTests: [], affectedIntegrationTests: [], totalUnitTests: 0,
    };
  }
  const removedEverywhere = new Set(deletedFiles.filter((path) => isServerProductSource(path)
    && !baseSources.has(path) && !headSources.has(path)));
  const baseReaders = readersOf(baseSources);
  const headReaders = readersOf(headSources, removedEverywhere);
  const unit = new Set<string>();
  const integration = new Set<string>();
  for (const path of ownedSources) {
    const baseReachable = new Set([
      ...transitiveTestReaders(path, baseReaders),
      ...transitiveTestReaders(path, headReaders),
    ]);
    const reachable = new Set([...baseReachable].filter((test) => headSources.has(test)
      && (isUnitTest(test) || runnableIntegrationTests.has(test))));
    // A removed source whose only owner was removed in the same PR has no
    // production behavior left to execute. The base graph still proves that
    // its removal was classified rather than silently skipped.
    const source = headSources.get(path) ?? baseSources.get(path);
    const typeOnly = source !== undefined && isTypeOnlyModule(path, source);
    if (reachable.size === 0 && !typeOnly && !removedEverywhere.has(path)
      && !(deletedFiles.includes(path) && baseReachable.size > 0)) {
      throw new Error(`No declared server test owner for ${path}; add a test that imports this source or declare its dynamic reader.`);
    }
    for (const scanner of directoryScanOwners(path, baseReaders, headReaders)) {
      if (headSources.has(scanner)) reachable.add(scanner);
    }
    for (const test of reachable) {
      if (isUnitTest(test)) unit.add(test);
      else if (isIntegrationTest(test)) integration.add(test);
    }
  }
  return {
    ownedSources,
    affectedUnitTests: [...unit].sort(),
    affectedIntegrationTests: [...integration].sort(),
    totalUnitTests: [...headSources.keys()].filter(isUnitTest).length,
  };
}
