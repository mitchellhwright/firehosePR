import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import ts from 'typescript';
import { workflowContractTestSet } from './workflowContractTests.ts';

/**
 * Which part of the repository runs each `scripts/` file. The validation
 * planner treats a script that only a workflow runs as a CI control file:
 * changing it cannot alter what the server suite exercises, so it schedules
 * the workflow contracts lane plus affected server contract tests. A script that package.json,
 * the Cloud Build pipeline, the container image or application code names,
 * or that nothing names at all, keeps the conservative full-suite routing.
 *
 * References include repository path mentions and parsed relative module
 * imports. A helper imported as './helper.mjs' has the same owner as a helper
 * invoked using its full repository path.
 */

export type ScriptConsumer = 'workflow' | 'package' | 'deploy' | 'application' | 'script' | 'server-test' | 'server-test-helper';

function isServerTest(path: string): boolean {
  return /^server\/tests\/.+\.test\.ts$/.test(path);
}

export function isServerTestHelper(path: string): boolean {
  return path.startsWith('server/tests/') && path.endsWith('.ts') && !isServerTest(path);
}

function walk(directory: string, predicate: (path: string) => boolean, out: string[] = []): string[] {
  if (!existsSync(directory)) return out;
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      if (!/node_modules|\/\.git$|\/dist$/.test(path)) walk(path, predicate, out);
    } else if (predicate(path)) out.push(path);
  }
  return out;
}

const consumerRoots: ReadonlyArray<readonly [ScriptConsumer, (root: string) => readonly string[]]> = [
  ['workflow', (root) => walk(join(root, '.github/workflows'), (p) => /\.ya?ml$/.test(p))],
  // The typed step programs are workflow bodies that moved out of the YAML, so
  // a script one of them spawns is named by a workflow just as it was before
  // the conversion.
  ['workflow', (root) => walk(join(root, 'ci/src'), (p) => p.endsWith('.ts'))],
  ['package', (root) => [join(root, 'package.json')].filter(existsSync)],
  ['deploy', (root) => readdirSync(root)
    .filter((name) => /^cloudbuild.*\.ya?ml$/.test(name) || /^Dockerfile/.test(name))
    .map((name) => join(root, name))],
  ['application', (root) => ['server', 'src', 'shared', 'pages'].flatMap((dir) =>
    walk(join(root, dir), (p) => /\.(ts|tsx|js|mjs|cjs|json|ya?ml)$/.test(p)))],
  ['script', (root) => walk(join(root, 'scripts'), (p) => /\.(sh|mjs|js|cjs|py|ts)$/.test(p) && !p.includes('/scripts/tests/'))],
];

function sourceConsumer(path: string): ScriptConsumer | undefined {
  if (/^\.github\/workflows\/.+\.ya?ml$/.test(path)) return 'workflow';
  if (/^ci\/src\/.+\.ts$/.test(path)) return 'workflow';
  // The trusted executor inventory, not the PR head, proves these suites run
  // in the workflow-contract lane. An unregistered script test grants no owner.
  if (workflowContractTestSet.has(path)) return 'workflow';
  if (path === 'package.json') return 'package';
  if (!path.includes('/') && (/^cloudbuild.*\.ya?ml$/.test(path) || /^Dockerfile/.test(path))) {
    return 'deploy';
  }
  if (isServerTest(path)) return 'server-test';
  if (isServerTestHelper(path)) return 'server-test-helper';
  if (/^(server|src|shared|pages)\/.+\.(ts|tsx|js|mjs|cjs|json|ya?ml)$/.test(path)) {
    return 'application';
  }
  if (/^scripts\/.+\.(sh|mjs|js|cjs|py|ts)$/.test(path) && !path.startsWith('scripts/tests/')) {
    return 'script';
  }
  return undefined;
}

/**
 * The iOS selector lists paths whose changes require a full iOS run. Those
 * strings are routing data, not calls from the selector to each listed file.
 * Keep real references elsewhere in the source available to the graph.
 */
function withoutIosRoutingTable(path: string, source: string): string {
  if (path !== 'scripts/select-ios-affected-tests.ts') return source;
  const parsed = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  for (const statement of parsed.statements) {
    if (!ts.isVariableStatement(statement)) continue;
    for (const declaration of statement.declarationList.declarations) {
      if (!ts.isIdentifier(declaration.name) || declaration.name.text !== 'fullRunFiles'
        || declaration.initializer === undefined || !ts.isArrayLiteralExpression(declaration.initializer)) continue;
      const start = declaration.initializer.getStart(parsed);
      const end = declaration.initializer.getEnd();
      return source.slice(0, start) + ' '.repeat(end - start) + source.slice(end);
    }
  }
  return source;
}

export function isScriptOwnershipSource(path: string): boolean {
  return sourceConsumer(path) !== undefined;
}

/**
 * Text inputs for the ownership graph. Keeping collection separate from
 * analysis lets the trusted planner overlay exact-head blobs without checking
 * out or executing PR code.
 */
export function repositoryScriptSources(root = process.cwd()): ReadonlyMap<string, string> {
  const files = new Set<string>();
  for (const [, paths] of consumerRoots) {
    for (const file of paths(root)) files.add(relative(root, file));
  }
  for (const file of walk(join(root, 'scripts'), (path) => /\.(sh|mjs|js|cjs|py|ts)$/.test(path))) {
    files.add(relative(root, file));
  }
  return new Map([...files].sort().map((path) => [path, readFileSync(join(root, path), 'utf8')]));
}

export interface ScriptReference {
  readonly consumer: ScriptConsumer;
  /** Repository-relative path of the file naming the script. */
  readonly file: string;
}

/** Scripts and test helpers with the source files that name them. */
export function scriptConsumersFromSources(
  sources: ReadonlyMap<string, string>,
  additionalScriptCandidates: readonly string[] = [],
): ReadonlyMap<string, readonly ScriptReference[]> {
  const scripts = [...new Set([...sources.keys(), ...additionalScriptCandidates])]
    .filter((path) => (
      /^scripts\/.+\.(sh|mjs|js|cjs|py|ts)$/.test(path) && !path.startsWith('scripts/tests/')
    ) || isServerTestHelper(path))
    .sort();
  const references = new Map<string, ScriptReference[]>(scripts.map((path) => [path, []]));
  for (const [relativeFile, source] of sources) {
      const consumer = sourceConsumer(relativeFile);
      if (consumer === undefined) continue;
      let text = withoutIosRoutingTable(relativeFile, source);
      if (relativeFile === 'package.json') {
        const manifest: unknown = JSON.parse(source);
        if (manifest === null || typeof manifest !== 'object' || Array.isArray(manifest)) {
          throw new Error('Exact-head package manifest must be an object');
        }
        // Decode escaped JSON path characters before matching repository paths.
        text = JSON.stringify(manifest);
      }
      const imports = new Set<string>();
      if (/\.[cm]?[jt]sx?$/.test(relativeFile)) {
        for (const { fileName } of ts.preProcessFile(text, true, true).importedFiles) {
          if (!fileName.startsWith('.')) continue;
          const target = relative('/', resolve('/', dirname(relativeFile), fileName));
          for (const candidate of [target, target.replace(/\.js$/, '.ts'), `${target}.ts`, `${target}.js`, `${target}/index.ts`, `${target}/index.js`]) {
            if (references.has(candidate)) { imports.add(candidate); break; }
          }
        }
      }
      for (const script of scripts) {
        if (relativeFile === script) continue;
        if (text.includes(script) || imports.has(script)) references.get(script)?.push({
          consumer,
          file: relativeFile,
        });
      }
  }
  return references;
}

/** Helpers are test-only only when every reader is another such helper or a
 * targetable server test. A product import anywhere in the exact-head source
 * view revokes the exemption for the complete helper chain.
 */
function testOnlyHelpers(consumers: ReadonlyMap<string, readonly ScriptReference[]>): ReadonlySet<string> {
  const candidates = new Set([...consumers.entries()]
    .filter(([path, refs]) => isServerTestHelper(path) && refs.length > 0
      && refs.every((ref) => ref.consumer === 'server-test'
        || ref.consumer === 'server-test-helper' || ref.consumer === 'workflow'))
    .map(([path]) => path));
  let changed = true;
  while (changed) {
    changed = false;
    for (const path of [...candidates]) {
      if (consumers.get(path)?.some((ref) =>
        ref.consumer === 'server-test-helper' && !candidates.has(ref.file))) {
        candidates.delete(path);
        changed = true;
      }
    }
  }
  const reachable = new Set([...candidates].filter((path) =>
    consumers.get(path)?.some((ref) => ref.consumer === 'server-test')));
  do {
    changed = false;
    for (const path of candidates) {
      if (!reachable.has(path) && consumers.get(path)?.some((ref) => reachable.has(ref.file))) {
        reachable.add(path);
        changed = true;
      }
    }
  } while (changed);
  return reachable;
}

/**
 * Keeps the trusted-base owner of a script that no longer exists at the exact
 * head. A deleted CI helper still needs its narrow workflow-contract route;
 * otherwise removing it becomes an unexplained script and widens to every
 * server and database check. Exact-head references win when any remain, and
 * deleted exact-head tests are never scheduled.
 */
export function retainDeletedScriptConsumers(
  base: ReadonlyMap<string, readonly ScriptReference[]>,
  head: ReadonlyMap<string, readonly ScriptReference[]>,
  headSources: ReadonlyMap<string, string>,
  deletedScripts: readonly string[],
): ReadonlyMap<string, readonly ScriptReference[]> {
  const combined = new Map(head);
  for (const script of deletedScripts) {
    if (headSources.has(script)) continue;
    const headReferences = head.get(script) ?? [];
    if (headReferences.length > 0) continue;
    const baseReferences = (base.get(script) ?? []).filter((reference) =>
      reference.consumer !== 'server-test' || headSources.has(reference.file));
    combined.set(script, baseReferences);
  }
  return combined;
}

/**
 * Preserve proven CI ownership when a whole chain of workflow scripts is
 * removed in one change. The combined graph cannot rediscover a deleted
 * helper's workflow ancestor after its deleted caller disappears from the
 * exact head. Base ownership is valid only for a deleted path with no
 * remaining exact-head references; an application or deployment reference at
 * the head must keep conservative validation.
 */
export function retainedDeletedWorkflowOnlyScripts(
  base: ReadonlyMap<string, readonly ScriptReference[]>,
  head: ReadonlyMap<string, readonly ScriptReference[]>,
  headSources: ReadonlyMap<string, string>,
  deletedScripts: readonly string[],
): string[] {
  const baseWorkflowOnly = new Set(workflowOnlyScripts(base));
  return deletedScripts.filter((path) =>
    !headSources.has(path)
    && (head.get(path)?.length ?? 0) === 0
    && baseWorkflowOnly.has(path));
}

/** Filesystem wrapper used by ordinary callers and focused fixtures. */
export function scriptConsumers(
  root = process.cwd(),
  headPackageManifest?: string,
): ReadonlyMap<string, readonly ScriptReference[]> {
  const sources = new Map(repositoryScriptSources(root));
  // Backward-compatible supplement for callers that only have the head
  // manifest. The trusted planner uses a complete exact-head source overlay.
  if (headPackageManifest !== undefined) {
    sources.set('package.json', headPackageManifest);
  }
  return scriptConsumersFromSources(sources);
}

/**
 * Scripts that only CI runs: named by a workflow, or only by scripts that are
 * themselves CI-only. Server test readers are separate validation dependencies
 * selected by affectedScriptServerTests; they are not application owners. A script nothing names is not
 * CI-only (it keeps full routing until someone decides what it is), and the
 * closure is a fixpoint so a helper two hops below a workflow qualifies while
 * one that package.json also names does not.
 */
export function workflowOnlyScripts(consumers: ReadonlyMap<string, readonly ScriptReference[]>): string[] {
  const helpers = testOnlyHelpers(consumers);
  const ciOnly = new Set([...consumers.entries()]
    .filter(([path, refs]) => path.startsWith('scripts/') && refs.length > 0
      && refs.every((ref) => ref.consumer === 'workflow' || ref.consumer === 'script'
        || ref.consumer === 'server-test'
        || (ref.consumer === 'server-test-helper' && helpers.has(ref.file))))
    .map(([path]) => path));
  let changed = true;
  while (changed) {
    changed = false;
    for (const path of [...ciOnly]) {
      const refs = consumers.get(path) ?? [];
      if (refs.some((ref) => ref.consumer === 'script' && !ciOnly.has(ref.file))) {
        ciOnly.delete(path);
        changed = true;
      }
    }
  }
  // A cycle of orphan helpers has no workflow owner. Require a path from an
  // actual workflow before granting the CI-only classification.
  const reachable = new Set([...ciOnly].filter((path) =>
    consumers.get(path)?.some((ref) => ref.consumer === 'workflow')));
  do {
    changed = false;
    for (const path of ciOnly) {
      if (!reachable.has(path) && consumers.get(path)?.some((ref) => reachable.has(ref.file))) {
        reachable.add(path);
        changed = true;
      }
    }
  } while (changed);
  return [...reachable].sort();
}

/** Tests that consume changed scripts, including through transitive helpers.
 * Test references are validation dependencies, not application-runtime owners.
 * Keep them in the plan instead of widening every helper to all server tests.
 */
export function affectedScriptServerTests(
  consumers: ReadonlyMap<string, readonly ScriptReference[]>,
  changedFiles: readonly string[],
): string[] {
  const visited = new Set<string>();
  const pending = [...changedFiles];
  const tests = new Set<string>();
  while (pending.length > 0) {
    const path = pending.pop();
    if (path === undefined || visited.has(path)) continue;
    visited.add(path);
    for (const ref of consumers.get(path) ?? []) {
      if (ref.consumer === 'server-test') tests.add(ref.file);
      else if (ref.consumer === 'script' || ref.consumer === 'server-test-helper') pending.push(ref.file);
    }
  }
  return [...tests].sort();
}

/** Keep ownership and its validation obligations together for planner callers. */
export function scriptValidationImpact(
  consumers: ReadonlyMap<string, readonly ScriptReference[]>,
  changedFiles: readonly string[],
) {
  const helpers = testOnlyHelpers(consumers);
  return {
    ciOnlyScripts: workflowOnlyScripts(consumers),
    affectedServerTests: affectedScriptServerTests(consumers, changedFiles),
    testOnlyHelpers: [...new Set(changedFiles.filter(path => helpers.has(path)))].sort(),
  };
}
