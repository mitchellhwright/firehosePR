import path from 'node:path';
import ts from 'typescript';

import {
  IOS_E2E_AUXILIARY_LANES,
  REAL_SERVER_LANE_INPUTS_SCHEMA,
  REAL_SERVER_SOURCE_ROOTS,
  isRealServerTestOnlyPath,
  defaultRealServerLanes,
  realServerLaneInputIndex,
  type IosE2eAuxiliaryLane,
  type RealServerLaneInputsContract,
} from './iosExecutionInputs.ts';
import { backendCommand } from './laneDevBackend.ts';
import { chatPlaidSeedArguments } from './realServerE2eLanes.ts';

/**
 * Generates the per-lane input closure of the real-server E2E lanes
 * (`ci/contracts/real-server-lane-inputs.v1.json`).
 *
 * Every lane starts the same Next dev server (`npm run dev`), whose API route
 * imports every Express router eagerly, so any module that server loads runs
 * its top-level code in every lane. A lane's inputs are therefore:
 *
 * - the import closure of what the lane's server loads: every Next API route,
 *   the Next proxy and config, and the scripts the `dev` npm script chain runs
 *   (type generation), plus the schema-job scripts and migrations
 *   `ios-tests.yml` runs before a lane;
 * - for Chat-Plaid, the `dev:seed:db` script closure and the seed file it loads;
 * - every repository file a module in the closure reads at runtime, from the
 *   declarations below. A closure module that touches the file system or
 *   anchors a path to its own location without a declaration fails generation,
 *   so a new runtime read cannot silently fall outside every closure.
 *
 * A file under the backend roots that is in no closure is an input to no lane.
 */

export interface RepositorySnapshot {
  /** Tracked repository files, repo-relative with forward slashes. */
  readonly files: readonly string[];
  read(file: string): string;
}

export interface RuntimeReadDeclaration {
  /** A module in a lane closure that reads repository files at runtime. */
  readonly reader: string;
  /** Tracked files the reader can read. Empty when it reads none. */
  readonly reads: readonly RegExp[];
  /**
   * The lanes that can execute the read. Omitted: every lane whose closure
   * loads the reader. Set only where the read happens on a request path a
   * lane's journey never drives; `reason` names that path.
   */
  readonly lanes?: readonly IosE2eAuxiliaryLane[];
  readonly reason: string;
}

const CHAT_ONLY: readonly IosE2eAuxiliaryLane[] = ['chat-plaid'];

export const RUNTIME_READS: readonly RuntimeReadDeclaration[] = [
  {
    reader: 'server/services/users/activationFlowService.ts',
    reads: [/^server\/data\/activation-flows\//],
    reason: 'Loads activation flow definitions from its data directory.',
  },
  {
    reader: 'server/services/dashboard/data/curatedSecurityClassifications.ts',
    reads: [/^server\/services\/dashboard\/data\/curatedSecurityClassifications\.json$/],
    reason: 'Parses the curated classification table beside it.',
  },
  {
    reader: 'server/services/chat/services/videoScripts.ts',
    reads: [/^server\/docs\/videos\//],
    lanes: CHAT_ONLY,
    reason: 'Read only by chat tool execution, which only the Chat Plaid journey drives.',
  },
  {
    reader: 'server/services/chat/rag/docsService.ts',
    reads: [/^server\/docs\//],
    lanes: CHAT_ONLY,
    reason: 'Queries the docs index `docs:rag:index` builds from server/docs at deploy; '
      + 'only chat tool execution queries it.',
  },
  {
    reader: 'server/docs/processDocs.ts',
    reads: [/^server\/docs\//],
    lanes: [],
    reason: 'Runs only from the admin-secret POST /api/process-docs, which no lane requests.',
  },
  {
    reader: 'server/swagger/spec.ts',
    reads: [/^server\/routes\/.+\.yaml$/, /^server\/swagger\/.+\.(?:ts|js)$/, /^server\/swagger\/userProfile\.yaml$/],
    reason: 'Builds the OpenAPI document from route YAML and swagger sources.',
  },
  {
    reader: 'server/utils/loadDocxDocuments.ts',
    reads: [/^server\/docs\//],
    lanes: [],
    reason: 'Reads the .docx path it is given; only processDocs (see above) calls it from a lane closure.',
  },
  {
    reader: 'scripts/generate-api-types.js',
    reads: [/^server\/routes\/.+\.yaml$/, /^server\/swagger\/.+\.(?:ts|js)$/, /^server\/swagger\/userProfile\.yaml$/, /^scripts\/generate-chat-context-schema\.js$/],
    reason: '`npm run dev` type generation: reads route and swagger YAML, and launches the chat '
      + 'context schema generator, which reads chat route YAML.',
  },
  {
    reader: 'scripts/generate-user-profile-ts-types.js',
    reads: [/^server\/swagger\/userProfile\.yaml$/],
    reason: '`npm run dev` type generation from the user profile swagger document.',
  },
  {
    reader: 'scripts/generate-user-profile-types.js',
    reads: [/^server\/swagger\/userProfile\.yaml$/],
    reason: '`npm run dev` type generation from the user profile swagger document.',
  },
  {
    reader: 'server/scripts/generate-api-types.ts',
    reads: [/^server\/routes\/.+\.yaml$/, /^server\/swagger\/.+\.(?:ts|js)$/, /^server\/swagger\/userProfile\.yaml$/, /^scripts\/generate-chat-context-schema\.js$/],
    reason: '`npm run dev` OpenAPI type generation: builds the swagger spec and launches the chat '
      + 'context schema generator.',
  },
  {
    reader: 'server/scripts/devE2eSchemaRevision.ts',
    reads: [/^server\/db\/migrations\//],
    reason: 'Schema job: reads the migration journal.',
  },
  {
    reader: 'server/scripts/verifyDevE2eSchemaRevision.ts',
    reads: [],
    reason: 'Schema job: reads the manifest the materialize step writes outside the repository.',
  },
  {
    reader: 'server/scripts/verifyPlaidSchedulerSchema.ts',
    reads: [/^server\/db\/migrations\//],
    reason: 'Schema job: reads the Plaid scheduler migration SQL.',
  },
  {
    reader: 'server/scripts/plaid/dev-seed-db.ts',
    reads: [],
    reason: 'Chat Plaid seed: reads the --file seed (a lane entry) and the untracked .env.',
  },
  {
    reader: 'server/routes/testBudgetE2E.ts',
    reads: [],
    reason: 'Reports process.cwd() in its metadata response; reads no file.',
  },
  {
    reader: 'server/services/notifications/notificationApnsProvider.ts',
    reads: [],
    reason: 'Reads the APNs key from APNS_KEY_PATH, outside the repository.',
  },
  {
    reader: 'server/utils/pushProvider.ts',
    reads: [],
    reason: 'Reads the APNs key from APNS_KEY_PATH, outside the repository.',
  },
];

const FILE_SYSTEM_READS = new Set([
  'readFile', 'readFileSync', 'readdir', 'readdirSync', 'createReadStream', 'opendir',
  'opendirSync', 'existsSync', 'stat', 'statSync', 'lstat', 'lstatSync', 'access',
  'accessSync', 'glob', 'globSync',
]);
// A script a module launches is a loader the import graph cannot follow, so
// importing child_process is itself a runtime-read site.
const PROCESS_LAUNCHERS = new Set(['child_process', 'node:child_process']);
const PATH_ANCHORS = new Set(['__dirname', '__filename']);
const CODE_FILE = /\.(?:[cm]?[jt]sx?)$/;
// The walk follows relative imports and treats every other specifier as a
// package. A path alias into the repository would escape it, so one fails.
const REPOSITORY_ALIAS = /^(?:@\/|~\/|(?:server|pages|shared|src)\/)/;
const RESOLVABLE_SUFFIXES =['', '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.json',
  '/index.ts', '/index.tsx', '/index.js'];

function parse(file: string, text: string): ts.SourceFile {
  const kind = /\.[cm]?jsx?$/.test(file)
    ? (file.endsWith('x') ? ts.ScriptKind.JSX : ts.ScriptKind.JS)
    : (file.endsWith('x') ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
  return ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, kind);
}

function isTypeOnlyImport(node: ts.ImportDeclaration): boolean {
  const clause = node.importClause;
  if (clause === undefined) return false;
  if (clause.isTypeOnly) return true;
  const bindings = clause.namedBindings;
  return clause.name === undefined && bindings !== undefined && ts.isNamedImports(bindings)
    && bindings.elements.length > 0 && bindings.elements.every((element) => element.isTypeOnly);
}

function isTypeOnlyExport(node: ts.ExportDeclaration): boolean {
  const clause = node.exportClause;
  return node.isTypeOnly || (clause !== undefined && ts.isNamedExports(clause)
    && clause.elements.length > 0 && clause.elements.every((element) => element.isTypeOnly));
}

function isLoaderCall(node: ts.CallExpression): boolean {
  return node.expression.kind === ts.SyntaxKind.ImportKeyword
    || (ts.isIdentifier(node.expression) && node.expression.text === 'require');
}

function calleeName(node: ts.CallExpression): string {
  const callee = node.expression;
  if (ts.isIdentifier(callee)) return callee.text;
  return ts.isPropertyAccessExpression(callee) ? callee.name.text : '';
}

interface ModuleFacts {
  /** Runtime module specifiers: type-only imports and exports erase. */
  readonly specifiers: readonly string[];
  /** Loaders whose target is not a string literal. */
  readonly opaque: readonly string[];
  /** File-system calls and self-location anchors: evidence of a runtime read. */
  readonly readSites: readonly string[];
}

function staticModuleSpecifier(node: ts.Node): string | undefined {
  if (ts.isImportDeclaration(node) && !isTypeOnlyImport(node)
    && ts.isStringLiteral(node.moduleSpecifier)) return node.moduleSpecifier.text;
  if (ts.isExportDeclaration(node) && !isTypeOnlyExport(node) && node.moduleSpecifier !== undefined
    && ts.isStringLiteral(node.moduleSpecifier)) return node.moduleSpecifier.text;
  return undefined;
}

function readSite(node: ts.Node): string | undefined {
  if (ts.isCallExpression(node)) {
    const name = calleeName(node);
    if (FILE_SYSTEM_READS.has(name)) return name;
    if (name === 'cwd' && node.expression.getText() === 'process.cwd') return 'process.cwd';
    return undefined;
  }
  if (ts.isIdentifier(node) && PATH_ANCHORS.has(node.text)) return node.text;
  if (ts.isMetaProperty(node) && ts.isPropertyAccessExpression(node.parent)) {
    return `import.meta.${node.parent.name.text}`;
  }
  return undefined;
}

export function moduleFacts(file: string, text: string): ModuleFacts {
  const specifiers: string[] = [];
  const opaque: string[] = [];
  const readSites = new Set<string>();
  const visit = (node: ts.Node): void => {
    const specifier = staticModuleSpecifier(node);
    if (specifier !== undefined) specifiers.push(specifier);
    if (ts.isCallExpression(node) && isLoaderCall(node)) {
      const [target] = node.arguments;
      if (target !== undefined && ts.isStringLiteralLike(target)) specifiers.push(target.text);
      else opaque.push(node.getText().slice(0, 120));
    }
    const site = readSite(node);
    if (site !== undefined) readSites.add(site);
    ts.forEachChild(node, visit);
  };
  visit(parse(file, text));
  if (specifiers.some((specifier) => PROCESS_LAUNCHERS.has(specifier))) readSites.add('child_process');
  return { specifiers, opaque, readSites: [...readSites].sort() };
}

class LaneInputError extends Error {
  constructor(problems: readonly string[]) {
    super(`Cannot generate real-server lane inputs:\n  ${problems.join('\n  ')}`);
    this.name = 'LaneInputError';
  }
}

interface ClosureWalk {
  readonly files: ReadonlySet<string>;
  readonly problems: readonly string[];
}

function resolveRelative(from: string, specifier: string, tracked: ReadonlySet<string>): string | undefined {
  const base = path.posix.normalize(path.posix.join(path.posix.dirname(from), specifier));
  const typescriptTwin = base.replace(/\.(m|c)?js$/, '.$1ts').replace(/\.jsx$/, '.tsx');
  return [typescriptTwin, ...RESOLVABLE_SUFFIXES.map((suffix) => `${base}${suffix}`)]
    .find((candidate) => tracked.has(candidate));
}

function walkClosure(
  snapshot: RepositorySnapshot,
  tracked: ReadonlySet<string>,
  entries: readonly string[],
): ClosureWalk {
  const files = new Set(entries);
  const queue = [...entries];
  const problems: string[] = [];
  for (let file = queue.shift(); file !== undefined; file = queue.shift()) {
    if (!CODE_FILE.test(file)) continue;
    const facts = moduleFacts(file, snapshot.read(file));
    problems.push(...facts.opaque.map((call) => `${file}: loader without a literal target: ${call}`));
    problems.push(...facts.specifiers.filter((value) => REPOSITORY_ALIAS.test(value))
      .map((value) => `${file}: import '${value}' names a repository tree without a relative path`));
    for (const specifier of facts.specifiers.filter((value) => value.startsWith('.'))) {
      const resolved = resolveRelative(file, specifier, tracked);
      if (resolved === undefined) {
        problems.push(`${file}: import '${specifier}' resolves to no tracked file`);
      } else if (!files.has(resolved)) {
        files.add(resolved);
        queue.push(resolved);
      }
    }
  }
  return { files, problems };
}

// An optional leading "./" is outside the capture, so the path is repo-relative.
const REPOSITORY_PATH = /(?:^|[\s"'=])(?:\.\/)?((?:server|scripts|shared|pages)\/[\w./[\]-]+)/g;
// A backend program the iOS workflow runs itself (the schema job). Only
// executed paths count: path lists the workflow merely classifies are not inputs.
const WORKFLOW_EXECUTION = /\b(?:tsx|node)\s+(?:\.\/)?(server\/[\w./-]+\.(?:ts|js|mjs|cjs))\b/g;

function packageScripts(snapshot: RepositorySnapshot): Readonly<Record<string, string>> {
  const manifest: unknown = JSON.parse(snapshot.read('package.json'));
  const scripts = typeof manifest === 'object' && manifest !== null && 'scripts' in manifest
    ? manifest.scripts : undefined;
  if (typeof scripts !== 'object' || scripts === null) throw new LaneInputError(['package.json has no scripts']);
  return scripts as Readonly<Record<string, string>>;
}

/** Repository files an npm script and every `npm run` it chains name. */
function npmScriptPaths(scripts: Readonly<Record<string, string>>, name: string): string[] {
  const seen = new Set<string>();
  const paths: string[] = [];
  const expand = (script: string): void => {
    if (seen.has(script)) return;
    seen.add(script);
    const command = scripts[script];
    if (command === undefined) throw new LaneInputError([`package.json has no script '${script}'`]);
    paths.push(...[...command.matchAll(REPOSITORY_PATH)].map((match) => match[1] ?? ''));
    for (const chained of command.matchAll(/npm run ([\w:-]+)/g)) expand(chained[1] ?? '');
  };
  expand(name);
  return paths;
}

/** Tracked files a path names: the file itself, or every file under a directory. */
function trackedUnder(named: string, snapshot: RepositorySnapshot): string[] {
  const prefix = named.endsWith('/') ? named : `${named}/`;
  return snapshot.files.filter((file) => file === named || file.startsWith(prefix));
}

function lanePaths(snapshot: RepositorySnapshot, named: readonly string[]): string[] {
  const problems = named.filter((file) => trackedUnder(file, snapshot).length === 0)
    .map((file) => `lane entry '${file}' names no tracked file`);
  if (problems.length > 0) throw new LaneInputError(problems);
  return named.flatMap((file) => trackedUnder(file, snapshot));
}

/**
 * Entry points each lane runs: the files the lane's server and setup commands
 * name, derived from the lane programs themselves rather than restated here.
 */
export function laneEntries(snapshot: RepositorySnapshot): Record<IosE2eAuxiliaryLane, readonly string[]> {
  const scripts = packageScripts(snapshot);
  const [, devScript = ''] = backendCommand(0).args;
  const seedArguments = chatPlaidSeedArguments({ email: '', password: '' });
  const [, seedScript = ''] = seedArguments;
  const seedFile = seedArguments[seedArguments.indexOf('--file') + 1] ?? '';
  const workflow = snapshot.read('.github/workflows/ios-tests.yml');
  const common = [
    ...snapshot.files.filter((file) => file.startsWith('pages/api/') && !isRealServerTestOnlyPath(file)),
    ...lanePaths(snapshot, ['proxy.ts', 'next.config.mjs', 'tsconfig.json']),
    ...lanePaths(snapshot, npmScriptPaths(scripts, devScript)),
    ...lanePaths(snapshot, [...workflow.matchAll(WORKFLOW_EXECUTION)].map((match) => match[1] ?? '')),
  ];
  const chatPlaid = lanePaths(snapshot, [...npmScriptPaths(scripts, seedScript), seedFile]);
  return {
    onboarding: common,
    'chat-plaid': [...common, ...chatPlaid],
    income: common,
    budget: common,
  };
}

function undeclaredReads(
  snapshot: RepositorySnapshot,
  loaded: ReadonlySet<string>,
  declarations: readonly RuntimeReadDeclaration[],
): string[] {
  const declared = new Set(declarations.map((declaration) => declaration.reader));
  const problems = [...loaded].filter((file) => CODE_FILE.test(file) && !declared.has(file))
    .flatMap((file) => {
      const sites = moduleFacts(file, snapshot.read(file)).readSites;
      return sites.length === 0 ? [] : [
        `${file} may read repository files at runtime (${sites.join(', ')}); `
        + 'declare what it reads in RUNTIME_READS',
      ];
    });
  const stale = declarations.filter((declaration) => !loaded.has(declaration.reader))
    .map((declaration) => `RUNTIME_READS names ${declaration.reader}, which no lane loads`);
  return [...problems, ...stale];
}

function readsFor(
  lane: IosE2eAuxiliaryLane,
  closure: ReadonlySet<string>,
  snapshot: RepositorySnapshot,
  declarations: readonly RuntimeReadDeclaration[],
): string[] {
  return declarations
    .filter((declaration) => closure.has(declaration.reader)
      && (declaration.lanes === undefined || declaration.lanes.includes(lane)))
    .flatMap((declaration) => snapshot.files.filter((file) => (
      declaration.reads.some((pattern) => pattern.test(file)))));
}

function groupByLanes(
  lanesByPath: ReadonlyMap<string, readonly IosE2eAuxiliaryLane[]>,
): RealServerLaneInputsContract['groups'] {
  const groups = new Map<string, { lanes: readonly IosE2eAuxiliaryLane[]; paths: string[] }>();
  for (const [file, lanes] of lanesByPath) {
    const key = lanes.join(',');
    const group = groups.get(key) ?? { lanes, paths: [] };
    group.paths.push(file);
    groups.set(key, group);
  }
  return [...groups.values()]
    .map((group) => ({ lanes: group.lanes, paths: group.paths.sort() }))
    .sort((left, right) => right.lanes.length - left.lanes.length
      || left.lanes.join(',').localeCompare(right.lanes.join(',')));
}

/**
 * Builds the contract for a repository snapshot: every non-test file under the
 * backend roots, and every file outside them a lane closure reaches, mapped to
 * the lanes whose closure contains it. Throws on anything the walk cannot
 * prove: loaders without literal targets, unresolved imports, undeclared or
 * stale runtime reads, and test-only files in a closure.
 */
export function buildRealServerLaneInputs(
  snapshot: RepositorySnapshot,
  declarations: readonly RuntimeReadDeclaration[] = RUNTIME_READS,
): RealServerLaneInputsContract {
  const tracked = new Set(snapshot.files);
  const entries = laneEntries(snapshot);
  const walks = IOS_E2E_AUXILIARY_LANES.map((lane) => ({ lane, ...walkClosure(snapshot, tracked, entries[lane]) }));
  const loaded = new Set(walks.flatMap((walk) => [...walk.files]));
  const problems = [
    ...new Set(walks.flatMap((walk) => walk.problems)),
    ...undeclaredReads(snapshot, loaded, declarations),
    ...[...loaded].filter(isRealServerTestOnlyPath).map((file) => `${file} is test-only but a lane loads it`),
  ];
  if (problems.length > 0) throw new LaneInputError(problems);

  const lanesByPath = new Map<string, IosE2eAuxiliaryLane[]>(snapshot.files
    .filter((file) => REAL_SERVER_SOURCE_ROOTS.some((root) => file.startsWith(root))
      && !isRealServerTestOnlyPath(file))
    .map((file) => [file, []]));
  for (const { lane, files } of walks) {
    for (const file of new Set([...files, ...readsFor(lane, files, snapshot, declarations)])) {
      const lanes = lanesByPath.get(file) ?? [];
      lanes.push(lane);
      lanesByPath.set(file, lanes);
    }
  }
  const exceptions = new Map([...lanesByPath]
    .filter(([file, lanes]) => lanes.join(',') !== defaultRealServerLanes(file).join(',')));
  return { schema: REAL_SERVER_LANE_INPUTS_SCHEMA, groups: groupByLanes(exceptions) };
}

export const REAL_SERVER_LANE_INPUTS_COMMENT = 'Generated by `npm run ci:server-lane-inputs` from '
  + 'ci/src/ios/realServerLaneInputs.ts. Lists only the paths whose real-server E2E lanes differ from '
  + 'the default (every lane for a non-test file under server/, pages/ and shared/; none elsewhere): '
  + 'backend files fewer lanes load, and files outside those trees a lane loads. '
  + '`npm run ci:server-lane-inputs:check` fails only when a path now reaches a lane this file '
  + 'does not grant it; added, removed and unloaded files never make it fail.';

export function serializeRealServerLaneInputs(contract: RealServerLaneInputsContract): string {
  return `${JSON.stringify({ $comment: REAL_SERVER_LANE_INPUTS_COMMENT, ...contract }, null, 2)}\n`;
}

function committedIndex(text: string): ReadonlyMap<string, readonly IosE2eAuxiliaryLane[]> {
  try {
    return realServerLaneInputIndex(JSON.parse(text));
  } catch {
    // An unreadable or missing committed contract grants only the defaults.
    return new Map();
  }
}

function lanesOf(
  index: ReadonlyMap<string, readonly IosE2eAuxiliaryLane[]>,
  file: string,
): readonly IosE2eAuxiliaryLane[] {
  return index.get(file) ?? defaultRealServerLanes(file);
}

/**
 * Paths a fresh contract gives a lane the committed one withholds: the only
 * staleness that could let a lane reuse evidence its inputs invalidated. A
 * committed contract that is merely wider (an added, removed or no longer
 * loaded file) is safe and not reported. `files` is the tree `generated`
 * was built from; a committed entry for a file no longer in it is ignored.
 */
export function unsafeRealServerLaneInputs(
  committed: string,
  generated: RealServerLaneInputsContract,
  files: readonly string[],
): string[] {
  const present = new Set(files);
  const before = committedIndex(committed);
  const after = realServerLaneInputIndex(generated);
  return [...new Set([...before.keys(), ...after.keys()])]
    .filter((file) => present.has(file) && !isRealServerTestOnlyPath(file))
    .filter((file) => {
      const granted = lanesOf(before, file);
      return lanesOf(after, file).some((lane) => !granted.includes(lane));
    })
    .sort();
}
