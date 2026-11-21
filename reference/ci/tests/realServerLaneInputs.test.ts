import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  IOS_E2E_AUXILIARY_LANES,
  defaultRealServerLanes,
  realServerLaneInputIndex,
  type IosE2eAuxiliaryLane,
} from '../src/ios/iosExecutionInputs.ts';
import {
  buildRealServerLaneInputs,
  moduleFacts,
  serializeRealServerLaneInputs,
  unsafeRealServerLaneInputs,
  type RuntimeReadDeclaration,
} from '../src/ios/realServerLaneInputs.ts';

const ALL = [...IOS_E2E_AUXILIARY_LANES];

// A backend shaped like the real one: one Next API route that mounts every
// router, a `dev` script that generates types first, a Chat Plaid seed script,
// and a schema job that reads migrations.
const FIXTURE: Readonly<Record<string, string>> = {
  'package.json': JSON.stringify({
    scripts: {
      dev: 'npm run gen:types && next dev',
      'gen:types': 'tsx server/scripts/generateTypes.ts',
      'dev:seed:db': 'ALLOW_DEV_DB_SEED=1 tsx server/scripts/plaid/dev-seed-db.ts',
    },
  }),
  // The schema job runs a verifier; the path list below it only classifies files.
  '.github/workflows/ios-tests.yml': [
    'run: ./node_modules/.bin/tsx server/scripts/verifySchema.ts "$ROOT/server/db/migrations"',
    'case "$file" in server/controllers/*|server/routes/users.ts) ;; esac',
  ].join('\n'),
  'proxy.ts': "import { policy } from './src/security/policy';\nexport default policy;\n",
  'src/security/policy.ts': 'export const policy = 1;\n',
  'src/components/Page.tsx': 'export const Page = 1;\n',
  'next.config.mjs': 'export default {};\n',
  'tsconfig.json': '{}\n',
  'pages/api/[...path].ts': "import routes from '../../server/routes/index';\nexport default routes;\n",
  'pages/index.tsx': "import { Page } from '../src/components/Page';\nexport default Page;\n",
  'server/routes/index.ts': [
    "import users from './users';",
    "import type { DebtSummary } from '../services/debt/types';",
    "export { docsAnswer } from '../services/chat/docsReader';",
    'export default users;',
    'export type Summary = DebtSummary;',
  ].join('\n'),
  'server/routes/users.ts': "import { debtTotal } from '../services/debt/debtService.js';\nexport default debtTotal;\n",
  'server/services/debt/debtService.ts': 'export const debtTotal = () => 1;\n',
  'server/services/debt/types.ts': 'export interface DebtSummary { total: number }\n',
  'server/services/debt/unused.ts': 'export const unused = 1;\n',
  'server/services/debt/seedOnly.ts': 'export const seedDebt = 1;\n',
  'server/services/chat/docsReader.ts': [
    "import { readFileSync } from 'node:fs';",
    "export const docsAnswer = () => readFileSync(new URL('../../docs/guide.md', import.meta.url), 'utf8');",
  ].join('\n'),
  'server/docs/guide.md': '# Guide\n',
  'server/scripts/generateTypes.ts': "import '../services/shared/generated';\n",
  'server/services/shared/generated.ts': 'export const generated = 1;\n',
  'server/scripts/plaid/dev-seed-db.ts': "import { seedDebt } from '../../services/debt/seedOnly';\nexport { seedDebt };\n",
  'server/testdata/chat-plaid-e2e-seed.json': '{}\n',
  'server/scripts/verifySchema.ts': "import { readdirSync } from 'node:fs';\nexport const verify = () => readdirSync(process.argv[2] ?? '');\n",
  'server/db/migrations/0001_init.sql': 'create table t ();\n',
  'server/tests/debtService.test.ts': "import '../services/debt/debtService';\n",
  'shared/schemas/profile.ts': 'export const profile = 1;\n',
};

const DOCS_READ: RuntimeReadDeclaration = {
  reader: 'server/services/chat/docsReader.ts',
  reads: [/^server\/docs\//],
  lanes: ['chat-plaid'],
  reason: 'fixture',
};

const MIGRATIONS_READ: RuntimeReadDeclaration = {
  reader: 'server/scripts/verifySchema.ts',
  reads: [/^server\/db\/migrations\//],
  reason: 'fixture',
};

function snapshot(overrides: Readonly<Record<string, string | undefined>> = {}) {
  const files = new Map(Object.entries({ ...FIXTURE, ...overrides })
    .filter((entry): entry is [string, string] => entry[1] !== undefined));
  return {
    files: [...files.keys()],
    read: (file: string) => {
      const text = files.get(file);
      if (text === undefined) throw new Error(`fixture has no ${file}`);
      return text;
    },
  };
}

function lanesByPath(
  overrides: Readonly<Record<string, string | undefined>> = {},
  declarations: readonly RuntimeReadDeclaration[] = [DOCS_READ, MIGRATIONS_READ],
): { get(file: string): readonly IosE2eAuxiliaryLane[]; has(file: string): boolean } {
  const exceptions = realServerLaneInputIndex(buildRealServerLaneInputs(snapshot(overrides), declarations));
  return {
    get: (file) => [...(exceptions.get(file) ?? defaultRealServerLanes(file))],
    has: (file) => exceptions.has(file),
  };
}

describe('real-server lane input closures', () => {
  it('reruns a debt service change only on the lanes whose closure loads it', () => {
    const index = lanesByPath();
    assert.deepEqual(index.get('server/services/debt/debtService.ts'), ALL);
    assert.deepEqual(index.get('server/services/debt/seedOnly.ts'), ['chat-plaid']);
    assert.deepEqual(index.get('server/services/debt/unused.ts'), []);
  });

  it('erases type-only imports', () => {
    assert.deepEqual(lanesByPath().get('server/services/debt/types.ts'), []);
  });

  it('names docs an input of Chat-Plaid alone through the declared chat read', () => {
    const index = lanesByPath();
    assert.deepEqual(index.get('server/docs/guide.md'), ['chat-plaid']);
    assert.deepEqual(index.get('server/services/chat/docsReader.ts'), ALL);
  });

  it('makes migrations, setup scripts and Next configuration inputs of every lane', () => {
    const index = lanesByPath();
    for (const file of [
      'server/db/migrations/0001_init.sql',
      'server/scripts/verifySchema.ts',
      'server/scripts/generateTypes.ts',
      'server/services/shared/generated.ts',
      'proxy.ts',
      'src/security/policy.ts',
      'next.config.mjs',
      'tsconfig.json',
    ]) assert.deepEqual(index.get(file), ALL, file);
    assert.deepEqual(index.get('server/testdata/chat-plaid-e2e-seed.json'), ['chat-plaid']);
  });

  it('leaves web pages, unloaded shared code and tests out of every lane', () => {
    const index = lanesByPath();
    assert.deepEqual(index.get('pages/index.tsx'), []);
    assert.deepEqual(index.get('shared/schemas/profile.ts'), []);
    assert.equal(index.has('src/components/Page.tsx'), false);
    assert.equal(index.has('server/tests/debtService.test.ts'), false);
  });

  it('follows dot-relative script paths in npm scripts and the workflow', () => {
    const index = lanesByPath({
      'package.json': JSON.stringify({
        scripts: {
          dev: 'npm run gen:types && next dev',
          'gen:types': 'tsx ./server/scripts/generateTypes.ts',
          'dev:seed:db': 'ALLOW_DEV_DB_SEED=1 tsx ./server/scripts/plaid/dev-seed-db.ts',
        },
      }),
      '.github/workflows/ios-tests.yml': 'run: node ./server/scripts/verifySchema.ts "$ROOT/server/db/migrations"\n',
    });
    assert.deepEqual(index.get('server/services/shared/generated.ts'), ALL);
    assert.deepEqual(index.get('server/services/debt/seedOnly.ts'), ['chat-plaid']);
    assert.deepEqual(index.get('server/db/migrations/0001_init.sql'), ALL);
  });

  it('serializes identically regardless of file order', () => {
    const forward = snapshot();
    const reversed = { ...forward, files: [...forward.files].reverse() };
    assert.equal(
      serializeRealServerLaneInputs(buildRealServerLaneInputs(forward, [DOCS_READ, MIGRATIONS_READ])),
      serializeRealServerLaneInputs(buildRealServerLaneInputs(reversed, [DOCS_READ, MIGRATIONS_READ])),
    );
  });
});

describe('real-server lane input proofs', () => {
  const rejects = (overrides: Readonly<Record<string, string | undefined>>, pattern: RegExp,
    declarations: readonly RuntimeReadDeclaration[] = [DOCS_READ, MIGRATIONS_READ]) => {
    assert.throws(() => buildRealServerLaneInputs(snapshot(overrides), declarations), pattern);
  };

  it('rejects a loaded module that reads files without a declaration', () => {
    rejects({ 'server/services/debt/debtService.ts': "import fs from 'node:fs';\nexport const debtTotal = () => fs.readdirSync('.');\n" },
      /server\/services\/debt\/debtService\.ts may read repository files at runtime \(readdirSync\)/);
  });

  it('rejects a loaded module that launches a process without a declaration', () => {
    rejects({ 'server/services/debt/debtService.ts': "import { execFileSync } from 'node:child_process';\nexport const debtTotal = execFileSync;\n" },
      /debtService\.ts may read repository files at runtime \(child_process\)/);
  });

  it('does not mistake RegExp#exec for a process launch', () => {
    const index = lanesByPath({ 'server/services/debt/debtService.ts': 'export const debtTotal = () => /a/.exec("a");\n' });
    assert.deepEqual(index.get('server/services/debt/debtService.ts'), ALL);
  });

  it('rejects a declaration for a reader no lane loads', () => {
    rejects({}, /RUNTIME_READS names server\/services\/debt\/unused\.ts, which no lane loads/, [
      DOCS_READ,
      MIGRATIONS_READ,
      { reader: 'server/services/debt/unused.ts', reads: [], reason: 'fixture' },
    ]);
  });

  it('rejects loaders without literal targets and unresolved imports', () => {
    rejects({ 'server/routes/users.ts': 'const name = "./x";\nexport default await import(name);\n' },
      /server\/routes\/users\.ts: loader without a literal target: import\(name\)/);
    rejects({ 'server/routes/users.ts': "export { gone } from '../services/gone';\n" },
      /server\/routes\/users\.ts: import '..\/services\/gone' resolves to no tracked file/);
    rejects({ 'server/routes/users.ts': "export { debtTotal as default } from '@/services/debt/debtService';\n" },
      /import '@\/services\/debt\/debtService' names a repository tree without a relative path/);
  });

  it('rejects a test-only file a lane loads', () => {
    rejects({ 'server/routes/users.ts': "export { x as default } from '../tests/helper.test';\n", 'server/tests/helper.test.ts': 'export const x = 1;\n' },
      /server\/tests\/helper\.test\.ts is test-only but a lane loads it/);
  });

  it('rejects a lane entry that names no tracked file', () => {
    rejects({ 'server/testdata/chat-plaid-e2e-seed.json': undefined },
      /lane entry 'server\/testdata\/chat-plaid-e2e-seed\.json' names no tracked file/);
  });
});

describe('real-server lane input drift', () => {
  const build = (overrides: Readonly<Record<string, string | undefined>> = {}) => (
    buildRealServerLaneInputs(snapshot(overrides), [DOCS_READ, MIGRATIONS_READ]));
  const committed = serializeRealServerLaneInputs(build());
  const unsafeAfter = (overrides: Readonly<Record<string, string | undefined>>, text = committed) => (
    unsafeRealServerLaneInputs(text, build(overrides), snapshot(overrides).files));

  it('lists only the paths whose lanes differ from the default', () => {
    const exceptions = realServerLaneInputIndex(build());
    assert.equal(exceptions.has('server/services/debt/debtService.ts'), false);
    assert.deepEqual(exceptions.get('server/services/debt/unused.ts'), []);
    assert.deepEqual(exceptions.get('server/docs/guide.md'), ['chat-plaid']);
    assert.deepEqual(exceptions.get('proxy.ts'), ALL);
  });

  it('is safe when nothing a closure depends on changed', () => {
    assert.deepEqual(unsafeAfter({}), []);
  });

  it('flags a file a new import brings into a lane the committed contract withholds', () => {
    assert.deepEqual(unsafeAfter({
      'server/routes/users.ts': "import '../services/debt/unused';\nimport { debtTotal } from '../services/debt/debtService.js';\nexport default debtTotal;\n",
    }), ['server/services/debt/unused.ts']);
  });

  it('flags a file outside the backend trees a lane starts loading', () => {
    assert.deepEqual(unsafeAfter({
      'proxy.ts': "import { policy } from './src/security/policy';\nimport { Page } from './src/components/Page';\nexport default [policy, Page];\n",
    }), ['src/components/Page.tsx']);
  });

  it('never fails for added, removed or no longer loaded files', () => {
    assert.deepEqual(unsafeAfter({ 'server/services/debt/newService.ts': 'export {};\n' }), []);
    assert.deepEqual(unsafeAfter({ 'server/services/debt/unused.ts': undefined }), []);
    assert.deepEqual(unsafeAfter({ 'server/routes/users.ts': 'export default () => 1;\n' }), []);
  });

  it('grants only the defaults when the committed contract is unreadable', () => {
    assert.deepEqual(unsafeAfter({}, '{'), [
      'next.config.mjs', 'proxy.ts', 'src/security/policy.ts', 'tsconfig.json',
    ]);
  });
});

describe('real-server lane input contract format', () => {
  it('rejects contracts that are not v1, have unknown lanes or repeat a path', () => {
    assert.throws(() => realServerLaneInputIndex({ schema: 'v0', groups: [] }), /not a example\.real-server-lane-inputs\.v1 contract/);
    assert.throws(() => realServerLaneInputIndex({
      schema: 'example.real-server-lane-inputs.v1', groups: [{ lanes: ['native'], paths: [] }],
    }), /malformed group/);
    assert.throws(() => realServerLaneInputIndex({
      schema: 'example.real-server-lane-inputs.v1',
      groups: [{ lanes: [], paths: ['a'] }, { lanes: ['income'], paths: ['a'] }],
    }), /list a twice/);
  });

  it('extracts runtime specifiers and read sites from a module', () => {
    const facts = moduleFacts('server/x.ts', [
      "import type { A } from './types';",
      "import { type B } from './typeOnly';",
      "import value, { type C } from './value';",
      "export * from './barrel';",
      "export type { D } from './typeExport';",
      "const lazy = () => import('./lazy');",
      'const dir = __dirname;',
    ].join('\n'));
    assert.deepEqual(facts.specifiers, ['./value', './barrel', './lazy']);
    assert.deepEqual(facts.readSites, ['__dirname']);
    assert.deepEqual(facts.opaque, []);
  });
});
