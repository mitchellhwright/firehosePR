import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';

import {
  findImportedImplementationFile,
  findImportedImplementationFileFromContent,
} from '../src/assuranceImportGraph.ts';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const isProductionCalculator = (candidate: string): boolean =>
  candidate === 'ci/tests/fixtures/assurance-import-graph/production/calculator.ts';

describe('findImportedImplementationFile', () => {
  it('returns null when the evidence file does not import the production module', () => {
    const violation = findImportedImplementationFile(
      repoRoot,
      'ci/tests/fixtures/assurance-import-graph/oracle/cleanOracle.test.ts',
      isProductionCalculator
    );

    assert.equal(violation, null);
  });

  it('detects a direct import of the production calculator', () => {
    const violation = findImportedImplementationFile(
      repoRoot,
      'ci/tests/fixtures/assurance-import-graph/oracle/violatingOracle.test.ts',
      isProductionCalculator
    );

    assert.equal(violation, 'ci/tests/fixtures/assurance-import-graph/production/calculator.ts');
  });

  it('detects an indirect import of the production calculator through a shared helper', () => {
    const violation = findImportedImplementationFile(
      repoRoot,
      'ci/tests/fixtures/assurance-import-graph/oracle/indirectOracle.test.ts',
      isProductionCalculator
    );

    assert.equal(violation, 'ci/tests/fixtures/assurance-import-graph/production/calculator.ts');
  });

  it('returns null when the evidence file does not exist on disk', () => {
    const violation = findImportedImplementationFile(
      repoRoot,
      'ci/tests/fixtures/assurance-import-graph/oracle/missing.test.ts',
      isProductionCalculator
    );

    assert.equal(violation, null);
  });

  it('resolves a dynamic import built from a non-interpolated template literal', () => {
    const violation = findImportedImplementationFile(
      repoRoot,
      'ci/tests/fixtures/assurance-import-graph/oracle/staticTemplateImportOracle.test.ts',
      isProductionCalculator
    );

    assert.equal(violation, 'ci/tests/fixtures/assurance-import-graph/production/calculator.ts');
  });

  it('fails closed on a dynamic import built from a variable instead of a literal', () => {
    assert.throws(
      () =>
        findImportedImplementationFile(
          repoRoot,
          'ci/tests/fixtures/assurance-import-graph/oracle/dynamicImportOracle.test.ts',
          isProductionCalculator
        ),
      /Unresolved dynamic import in calculation assurance evidence import graph: import\(modulePath\)/
    );
  });

  it('ignores commented-out imports instead of inventing an edge or failing closed', () => {
    const violation = findImportedImplementationFile(
      repoRoot,
      'ci/tests/fixtures/assurance-import-graph/oracle/commentedImportOracle.test.ts',
      isProductionCalculator
    );

    assert.equal(violation, null);
  });

  it('detects a production module loaded through vi.importActual', () => {
    const violation = findImportedImplementationFile(
      repoRoot,
      'ci/tests/fixtures/assurance-import-graph/oracle/mockActualOracle.test.ts',
      isProductionCalculator
    );

    assert.equal(violation, 'ci/tests/fixtures/assurance-import-graph/production/calculator.ts');
  });

  it('detects a production module loaded through a createRequire-produced require alias', () => {
    const violation = findImportedImplementationFile(
      repoRoot,
      'ci/tests/fixtures/assurance-import-graph/oracle/createRequireOracle.test.ts',
      isProductionCalculator
    );

    assert.equal(violation, 'ci/tests/fixtures/assurance-import-graph/production/calculator.ts');
  });
});

// A trusted-base CI checkout does not reflect the PR under review, so the isolation check that
// runs there must validate against independently verified exact-head content instead of disk.
// These mirror the disk-based fixtures above one for one to prove the two sources agree.
describe('findImportedImplementationFileFromContent', () => {
  const productionPath = 'production/calculator.ts';
  const isProductionCalculatorPath = (candidate: string): boolean => candidate === productionPath;

  it('returns null when the evidence content does not import the production module', () => {
    const content = new Map([
      [
        'oracle/cleanOracle.test.ts',
        "import assert from 'node:assert/strict';\n\nassert.equal(0.1 * 100, 10);\n",
      ],
    ]);

    const violation = findImportedImplementationFileFromContent(
      'oracle/cleanOracle.test.ts',
      content,
      isProductionCalculatorPath
    );

    assert.equal(violation, null);
  });

  it('detects a direct import of the production calculator', () => {
    const content = new Map([
      [
        'oracle/violatingOracle.test.ts',
        "import { calculateBenefit } from '../production/calculator.ts';\n\ncalculateBenefit(100);\n",
      ],
      [
        productionPath,
        'export function calculateBenefit(value: number): number { return value / 10; }\n',
      ],
    ]);

    const violation = findImportedImplementationFileFromContent(
      'oracle/violatingOracle.test.ts',
      content,
      isProductionCalculatorPath
    );

    assert.equal(violation, productionPath);
  });

  it('detects an indirect import of the production calculator through a shared helper', () => {
    const content = new Map([
      [
        'oracle/indirectOracle.test.ts',
        "import { calculateBenefit } from '../production/helper.ts';\n\ncalculateBenefit(100);\n",
      ],
      ['production/helper.ts', "export { calculateBenefit } from './calculator.ts';\n"],
      [
        productionPath,
        'export function calculateBenefit(value: number): number { return value / 10; }\n',
      ],
    ]);

    const violation = findImportedImplementationFileFromContent(
      'oracle/indirectOracle.test.ts',
      content,
      isProductionCalculatorPath
    );

    assert.equal(violation, productionPath);
  });

  it('returns null when the entry path is missing from the verified content map', () => {
    const violation = findImportedImplementationFileFromContent(
      'oracle/missing.test.ts',
      new Map(),
      isProductionCalculatorPath
    );

    assert.equal(violation, null);
  });

  it('never falls back to reading the local disk for content it was not given', () => {
    // Regression for the trusted-base checkout gap: an entry file that imports a helper the
    // caller never fetched must not resolve that helper from whatever happens to be on disk.
    const content = new Map([
      [
        'oracle/indirectOracle.test.ts',
        "import { calculateBenefit } from '../production/helper.ts';\n\ncalculateBenefit(100);\n",
      ],
      // production/helper.ts is deliberately omitted even though it exists on disk at
      // ci/tests/fixtures/assurance-import-graph/production/helper.ts.
    ]);

    const violation = findImportedImplementationFileFromContent(
      'oracle/indirectOracle.test.ts',
      content,
      isProductionCalculatorPath
    );

    assert.equal(violation, null);
  });

  it('resolves a dynamic import built from a non-interpolated template literal', () => {
    const content = new Map([
      [
        'oracle/violatingOracle.test.ts',
        'const { calculateBenefit } = await import(`../production/calculator.js`);\n\ncalculateBenefit(100);\n',
      ],
      [
        productionPath,
        'export function calculateBenefit(value: number): number { return value / 10; }\n',
      ],
    ]);

    const violation = findImportedImplementationFileFromContent(
      'oracle/violatingOracle.test.ts',
      content,
      isProductionCalculatorPath
    );

    assert.equal(violation, productionPath);
  });

  it('fails closed on a dynamic import built from an interpolated template literal', () => {
    const content = new Map([
      [
        'oracle/violatingOracle.test.ts',
        'const dir = "../production";\nconst mod = await import(`${dir}/calculator.js`);\n',
      ],
    ]);

    assert.throws(
      () =>
        findImportedImplementationFileFromContent(
          'oracle/violatingOracle.test.ts',
          content,
          isProductionCalculatorPath
        ),
      /Unresolved dynamic import in calculation assurance evidence import graph/
    );
  });

  it('fails closed on a dynamic import built from a variable instead of a literal', () => {
    const content = new Map([
      [
        'oracle/violatingOracle.test.ts',
        "const modulePath = '../production/calculator.js';\nconst mod = await import(modulePath);\n",
      ],
    ]);

    assert.throws(
      () =>
        findImportedImplementationFileFromContent(
          'oracle/violatingOracle.test.ts',
          content,
          isProductionCalculatorPath
        ),
      /Unresolved dynamic import in calculation assurance evidence import graph: import\(modulePath\)/
    );
  });

  function violationIn(entrySource: string): string | null {
    const content = new Map([
      ['oracle/violatingOracle.test.ts', entrySource],
      [
        productionPath,
        'export function calculateBenefit(value: number): number { return value / 10; }\n',
      ],
    ]);

    return findImportedImplementationFileFromContent(
      'oracle/violatingOracle.test.ts',
      content,
      isProductionCalculatorPath
    );
  }

  it('ignores a static import that only appears inside a line comment', () => {
    assert.equal(
      violationIn(
        "// import { calculateBenefit } from '../production/calculator.ts';\nexport {};\n"
      ),
      null
    );
  });

  it('ignores a static import that only appears inside a block comment', () => {
    assert.equal(
      violationIn(
        "/*\nimport { calculateBenefit } from '../production/calculator.ts';\n*/\nexport {};\n"
      ),
      null
    );
  });

  it('ignores a commented-out dynamic import instead of failing closed on it', () => {
    // Regression: an unresolvable specifier that is only ever discussed in prose is not an import,
    // so scanning it turned every explanatory comment into a hard planning failure.
    assert.equal(violationIn('// const mod = await import(modulePath);\nexport {};\n'), null);
  });

  it('keeps reading code that follows a URL string containing a double slash', () => {
    assert.equal(
      violationIn(
        "const rule = 'https://example.gov/rule'; " +
          "import { calculateBenefit } from '../production/calculator.ts';\n"
      ),
      productionPath
    );
  });

  it('keeps reading code that follows a regular-expression literal containing slashes', () => {
    assert.equal(
      violationIn(
        'const scheme = /https:\\/\\//; ' +
          "const mod = await import('../production/calculator.ts');\n"
      ),
      productionPath
    );
  });

  it('detects a production module loaded through vi.importActual', () => {
    assert.equal(
      violationIn("const actual = await vi.importActual('../production/calculator.js');\n"),
      productionPath
    );
  });

  it('detects a production module loaded through vi.importActual with a type argument', () => {
    // The type argument deliberately does not name the module, so the specifier can only be read
    // by stepping over the type argument list to the real call.
    assert.equal(
      violationIn(
        'const actual = await vi.importActual<{ calculateBenefit: (value: number) => number }>' +
          "('../production/calculator.js');\n"
      ),
      productionPath
    );
  });

  it('detects a production module loaded through a non-interpolated template vi.importActual', () => {
    assert.equal(
      violationIn('const actual = await vi.importActual(`../production/calculator.js`);\n'),
      productionPath
    );
  });

  it('detects a production module loaded through vi.importOriginal with an explicit specifier', () => {
    assert.equal(
      violationIn("const actual = await vi.importOriginal('../production/calculator.js');\n"),
      productionPath
    );
  });

  it('does not treat a declared importOriginal factory parameter as a call', () => {
    assert.equal(
      violationIn(
        "vi.mock('../production/clock.js', async (importOriginal) => ({}));\nexport {};\n"
      ),
      null
    );
  });

  it('fails closed on a zero-argument importOriginal that loads the enclosing mock', () => {
    assert.throws(
      () =>
        violationIn(
          "vi.mock('../production/calculator.js', async (importOriginal) => {\n" +
            '  const actual = await importOriginal();\n  return actual;\n});\n'
        ),
      /Unresolved importOriginal\(\) in calculation assurance evidence import graph/
    );
  });

  it('fails closed on vi.importActual built from a variable instead of a literal', () => {
    assert.throws(
      () =>
        violationIn(
          "const modulePath = '../production/calculator.js';\n" +
            'const actual = await vi.importActual(modulePath);\n'
        ),
      /Unresolved vi\.importActual call in calculation assurance evidence import graph: vi\.importActual\(modulePath\)/
    );
  });

  it('tracks a copied Vitest loader to a production module', () => {
    assert.equal(
      violationIn(
        'const load = vi.importActual;\n' +
          "const actual = await load('../production/calculator.js');\n"
      ),
      productionPath
    );
  });

  it('fails closed on a renamed vi.mock loader parameter', () => {
    assert.throws(
      () =>
        violationIn(
          "vi.mock('../production/calculator.js', async (load) => {\n" +
            "  const modulePath = '../production/calculator.js';\n" +
            '  return load(modulePath);\n});\n'
        ),
      /Unresolved load call/
    );
  });

  const transparentVitestLoaderCases = [
    ['parenthesized loader', '(vi.importActual)(modulePath);\n'],
    ['non-null loader', 'vi.importActual!(modulePath);\n'],
    ['cast loader', '(vi.importActual as typeof vi.importActual)(modulePath);\n'],
  ] as const;
  for (const [name, use] of transparentVitestLoaderCases) {
    it(`fails closed on ${name} Vitest module loading`, () => {
      assert.throws(
        () => violationIn("const modulePath = '../production/calculator.js';\n" + use),
        /Unresolved/
      );
    });
  }

  const opaqueVitestLoaderCases = [
    ['computed loader', "vi['importActual'](modulePath);\n"],
    ['optional computed loader', "vi?.['importActual']?.(modulePath);\n"],
    ['Function helper', 'vi.importActual.call(vi, modulePath);\n'],
    ['Reflect.apply', 'Reflect.apply(vi.importActual, vi, [modulePath]);\n'],
  ] as const;
  for (const [name, use] of opaqueVitestLoaderCases) {
    it(`fails closed on ${name} Vitest module loading`, () => {
      assert.throws(
        () => violationIn("const modulePath = '../production/calculator.js';\n" + use),
        /Unsupported/
      );
    });
  }

  it('detects a production module loaded through a createRequire-produced require alias', () => {
    assert.equal(
      violationIn(
        "import { createRequire } from 'node:module';\n" +
          'const require = createRequire(import.meta.url);\n' +
          "const { calculateBenefit } = require('../production/calculator.js');\n"
      ),
      productionPath
    );
  });

  it('detects a production module loaded through a require alias bound with a different name', () => {
    assert.equal(
      violationIn(
        "import { createRequire } from 'module';\n" +
          'const req = createRequire(import.meta.url);\n' +
          "req('../production/calculator.js');\n"
      ),
      productionPath
    );
  });

  it('detects a require alias whose createRequire assignment spans lines', () => {
    assert.equal(
      violationIn(
        "import { createRequire } from 'node:module';\n" +
          'const require =\n' +
          '  createRequire(import.meta.url);\n' +
          "require('../production/calculator.js');\n"
      ),
      productionPath
    );
  });

  it('detects a production module loaded through a renamed createRequire import', () => {
    assert.equal(
      violationIn(
        "import { createRequire as cr } from 'node:module';\n" +
          'const require: NodeRequire = cr(import.meta.url);\n' +
          "require('../production/calculator.js');\n"
      ),
      productionPath
    );
  });

  it('detects a production module loaded by immediately invoking createRequire', () => {
    assert.equal(
      violationIn(
        "import { createRequire } from 'node:module';\n" +
          "const calculator = createRequire(import.meta.url)('../production/calculator.js');\n" +
          'void calculator;\n'
      ),
      productionPath
    );
  });

  it('detects an optional immediate createRequire call with a static template specifier', () => {
    assert.equal(
      violationIn(
        "import { createRequire as cr } from 'module';\n" +
          'const calculator = cr(import.meta.url)?.(`../production/calculator.js`);\n' +
          'void calculator;\n'
      ),
      productionPath
    );
  });

  it('fails closed on an immediately invoked createRequire loader with a dynamic specifier', () => {
    assert.throws(
      () =>
        violationIn(
          "import { createRequire } from 'node:module';\n" +
            "const modulePath = '../production/calculator.js';\n" +
            'const calculator = createRequire(import.meta.url)(modulePath);\n' +
            'void calculator;\n'
        ),
      /Unresolved createRequire call/
    );
  });

  it('detects a parenthesized createRequire result that is immediately invoked', () => {
    assert.equal(
      violationIn(
        "import { createRequire } from 'node:module';\n" +
          "const calculator = (createRequire(import.meta.url))('../production/calculator.js');\n" +
          'void calculator;\n'
      ),
      productionPath
    );
  });

  it('fails closed when an immediate createRequire result is invoked through call', () => {
    assert.throws(
      () =>
        violationIn(
          "import { createRequire } from 'node:module';\n" +
            "const modulePath = '../production/calculator.js';\n" +
            'const calculator = createRequire(import.meta.url).call(null, modulePath);\n' +
            'void calculator;\n'
        ),
      /Unsupported/
    );
  });

  const callableMemberCases = [
    ['call', 'require.call(null, modulePath)'],
    ['apply', 'require.apply(null, [modulePath])'],
    ['bind', 'require.bind(null)(modulePath)'],
  ] as const;
  for (const [member, expression] of callableMemberCases) {
    it(`fails closed when a named require alias is invoked through ${member}`, () => {
      assert.throws(
        () =>
          violationIn(
            "import { createRequire } from 'node:module';\n" +
              'const require = createRequire(import.meta.url);\n' +
              "const modulePath = '../production/calculator.js';\n" +
              `const calculator = ${expression};\n` +
              'void calculator;\n'
          ),
        /Unsupported/
      );
    });
  }

  it('fails closed when a named require alias uses optional call invocation', () => {
    assert.throws(
      () =>
        violationIn(
          "import { createRequire } from 'node:module';\n" +
            'const require = createRequire(import.meta.url);\n' +
            'const calculator = require.call?.(null, modulePath);\n' +
            'void calculator;\n'
        ),
      /Unsupported/
    );
  });

  const propagatedAliasCases = [
    ['a direct copied alias', 'const req = require;\n'],
    ['a later alias assignment', 'let req;\nreq = require;\n'],
    ['a parenthesized alias assignment', 'const req = (require);\n'],
  ] as const;
  for (const [name, propagation] of propagatedAliasCases) {
    it(`tracks ${name} to a production module`, () => {
      assert.equal(
        violationIn(
          "import { createRequire } from 'node:module';\n" +
            'const require = createRequire(import.meta.url);\n' +
            propagation +
            "req('../production/calculator.js');\n"
        ),
        productionPath
      );
    });
  }

  it('fails closed on a dynamic specifier called through a copied require alias', () => {
    assert.throws(
      () =>
        violationIn(
          "import { createRequire } from 'node:module';\n" +
            'const require = createRequire(import.meta.url);\n' +
            'const req = require;\n' +
            "const modulePath = '../production/calculator.js';\n" +
            'req(modulePath);\n'
        ),
      /Unresolved req call/
    );
  });

  const transparentDynamicLoaderCases = [
    ['parenthesized alias call', '(require)(modulePath);\n'],
    ['non-null alias call', 'require!(modulePath);\n'],
    ['cast alias call', '(require as NodeRequire)(modulePath);\n'],
    ['non-null immediate factory call', 'createRequire(import.meta.url)!(modulePath);\n'],
    [
      'cast immediate factory call',
      '(createRequire(import.meta.url) as NodeRequire)(modulePath);\n',
    ],
  ] as const;
  for (const [name, use] of transparentDynamicLoaderCases) {
    it(`fails closed on ${name}`, () => {
      assert.throws(
        () =>
          violationIn(
            "import { createRequire } from 'node:module';\n" +
              'const require = createRequire(import.meta.url);\n' +
              "const modulePath = '../production/calculator.js';\n" +
              use
          ),
        /Unresolved/
      );
    });
  }

  const opaqueLoaderCases = [
    ['destructured loader copy', 'const { load: req } = { load: require };\nreq(modulePath);\n'],
    ['loader stored in an object', '({ load: require }).load(modulePath);\n'],
    ['Reflect.apply', 'Reflect.apply(require, null, [modulePath]);\n'],
    ['computed call helper', "require['call'](null, modulePath);\n"],
    ['optional computed call helper', "require?.['call']?.(null, modulePath);\n"],
    [
      'computed immediate factory helper',
      "createRequire(import.meta.url)['call'](null, modulePath);\n",
    ],
    ['factory Function helper', 'createRequire.call(null, import.meta.url);\n'],
    ['evaluated loader call', 'eval("require(\'../production/calculator.js\')");\n'],
  ] as const;
  for (const [name, use] of opaqueLoaderCases) {
    it(`fails closed on ${name}`, () => {
      assert.throws(
        () =>
          violationIn(
            "import { createRequire } from 'node:module';\n" +
              'const require = createRequire(import.meta.url);\n' +
              "const modulePath = '../production/calculator.js';\n" +
              use
          ),
        /Unsupported/
      );
    });
  }

  const unsupportedAcquisitionCases = [
    [
      'namespace import',
      "import * as moduleApi from 'node:module';\nmoduleApi.createRequire(import.meta.url);\n",
    ],
    [
      'default import',
      "import moduleApi from 'node:module';\nmoduleApi.createRequire(import.meta.url);\n",
    ],
    [
      'dynamic builtin import',
      "const { createRequire } = await import('node:module');\ncreateRequire(import.meta.url);\n",
    ],
  ] as const;
  for (const [name, source] of unsupportedAcquisitionCases) {
    it(`fails closed on ${name} createRequire acquisition`, () => {
      assert.throws(() => violationIn(source), /Unsupported/);
    });
  }

  it('detects an indirect require-alias load of the production calculator through a shared helper', () => {
    const content = new Map([
      [
        'oracle/violatingOracle.test.ts',
        "import { createRequire } from 'node:module';\n" +
          'const require = createRequire(import.meta.url);\n' +
          "const { calculateBenefit } = require('../production/helper.js');\n",
      ],
      ['production/helper.ts', "export { calculateBenefit } from './calculator.ts';\n"],
      [
        productionPath,
        'export function calculateBenefit(value: number): number { return value / 10; }\n',
      ],
    ]);

    const violation = findImportedImplementationFileFromContent(
      'oracle/violatingOracle.test.ts',
      content,
      isProductionCalculatorPath
    );

    assert.equal(violation, productionPath);
  });

  it('resolves a require call built from a non-interpolated template literal', () => {
    assert.equal(
      violationIn(
        "import { createRequire } from 'node:module';\n" +
          'const require = createRequire(import.meta.url);\n' +
          'require(`../production/calculator.js`);\n'
      ),
      productionPath
    );
  });

  it('fails closed on a require-alias call built from a variable instead of a literal', () => {
    assert.throws(
      () =>
        violationIn(
          "import { createRequire } from 'node:module';\n" +
            'const require = createRequire(import.meta.url);\n' +
            "const modulePath = '../production/calculator.js';\n" +
            'require(modulePath);\n'
        ),
      /Unresolved require call in calculation assurance evidence import graph: require\(modulePath\)/
    );
  });

  it('fails closed on a require-alias call built from an interpolated template literal', () => {
    assert.throws(
      () =>
        violationIn(
          "import { createRequire } from 'node:module';\n" +
            'const require = createRequire(import.meta.url);\n' +
            'const dir = "../production";\n' +
            'require(`${dir}/calculator.js`);\n'
        ),
      /Unresolved require call in calculation assurance evidence import graph: require\(`\$\{dir\}\/calculator\.js`\)/
    );
  });

  it('tracks createRequire re-exported through a local helper', () => {
    assert.equal(
      violationIn(
        "import { createRequire } from '../production/helper.ts';\n" +
          'const require = createRequire(import.meta.url);\n' +
          "require('../production/calculator.js');\n"
      ),
      productionPath
    );
  });

  it('ignores a require-alias setup that only appears inside a block comment', () => {
    assert.equal(
      violationIn(
        '/*\n' +
          "import { createRequire } from 'node:module';\n" +
          'const require = createRequire(import.meta.url);\n' +
          "require('../production/calculator.js');\n" +
          '*/\n' +
          'export {};\n'
      ),
      null
    );
  });

  it('ignores a createRequire import that only appears inside a string literal', () => {
    // Regression: the import-clause scan must consult the literal mask, or prose describing the
    // createRequire idiom inside a string would make the real `createRequire(...)` call below —
    // whose binding was never actually imported here — look like a genuine require alias.
    assert.equal(
      violationIn(
        'const example = "import { createRequire } from \'node:module\';";\n' +
          'const require = createRequire(import.meta.url);\n' +
          "require('../production/calculator.js');\n"
      ),
      null
    );
  });

  it('ignores a require-alias call that only appears inside a string literal', () => {
    assert.equal(
      violationIn(
        "import { createRequire } from 'node:module';\n" +
          'const require = createRequire(import.meta.url);\n' +
          '// eslint-disable-next-line no-unused-vars\n' +
          'const example = "call require(\'../production/calculator.js\') to load it";\n'
      ),
      null
    );
  });

  it('ignores a require-alias call that only appears inside a regular-expression literal', () => {
    // The unescaped `(x)` forms a real capture group, so this only stays a regression check on the
    // literal mask if the require-call scan skips it; unguarded, it would read `x` as the argument
    // and fail closed instead of silently ignoring it.
    assert.equal(
      violationIn(
        "import { createRequire } from 'node:module';\n" +
          'const require = createRequire(import.meta.url);\n' +
          'const pattern = /require(x)/;\n' +
          'assert.equal(pattern.test(""), false);\n'
      ),
      null
    );
  });

  const astStaticLoaderCases = [
    [
      'mixed default and named createRequire import',
      "import moduleApi, { createRequire as makeRequire } from 'node:module';\n" +
        "makeRequire(import.meta.url)('../production/calculator.js');\n",
    ],
    [
      'process.getBuiltinModule createRequire acquisition',
      "process.getBuiltinModule('node:module').createRequire(import.meta.url)" +
        "('../production/calculator.js');\n",
    ],
    [
      'optional direct loader invocation',
      "import { createRequire } from 'node:module';\n" +
        'const req = createRequire(import.meta.url);\n' +
        "req?.('../production/calculator.js');\n",
    ],
  ] as const;
  for (const [name, source] of astStaticLoaderCases) {
    it(`detects ${name}`, () => {
      assert.equal(violationIn(source), productionPath);
    });
  }

  const astVitestFactoryCases = [
    [
      'aliased vi receiver',
      'const vitest = vi;\n' +
        "vitest.mock('../production/calculator.js', async (load) => {\n" +
        "  const modulePath = '../production/calculator.js';\n" +
        '  return load(modulePath);\n});\n',
    ],
    [
      'function callback',
      "vi.mock('../production/calculator.js', async function(load) {\n" +
        "  const modulePath = '../production/calculator.js';\n" +
        '  return load(modulePath);\n});\n',
    ],
    [
      'typed arrow callback',
      "vi.mock('../production/calculator.js', async (load: <T>(path: string) => Promise<T>) => {\n" +
        "  const modulePath = '../production/calculator.js';\n" +
        '  return load(modulePath);\n});\n',
    ],
  ] as const;
  for (const [name, source] of astVitestFactoryCases) {
    it(`fails closed on a dynamic loader in a ${name}`, () => {
      assert.throws(() => violationIn(source), /Unresolved load call/);
    });
  }

  const astNonExecutableTextCases = [
    [
      'type-only dynamic import',
      "type Calculator = typeof import('../production/calculator.ts');\nexport {};\n",
    ],
    [
      'interface loader method',
      'interface Loader { importActual(path: string): Promise<unknown>; }\nexport {};\n',
    ],
    [
      'quoted import prose',
      'const guidance = "import { calculator } from \'../production/calculator.js\'";\n' +
        'void guidance;\n',
    ],
    [
      'type-only static import',
      "import type { Calculator } from '../production/calculator.ts';\nexport {};\n",
    ],
    [
      'JSX import prose',
      "const guidance = <p>import calculator from '../production/calculator.ts'</p>;\n" +
        'void guidance;\n',
    ],
  ] as const;
  for (const [name, source] of astNonExecutableTextCases) {
    it(`ignores ${name}`, () => {
      assert.equal(violationIn(source), null);
    });
  }

  const astUnsupportedTaintCases = [
    ['destructuring', 'const { call } = require;\nvoid call;\n'],
    ['computed member', "require['resolve']('../production/calculator.js');\n"],
    ['call helper', "require.call(null, '../production/calculator.js');\n"],
    ['apply helper', "require.apply(null, ['../production/calculator.js']);\n"],
    ['bind helper', "require.bind(null)('../production/calculator.js');\n"],
    ['object escape', 'const escaped = { require };\nvoid escaped;\n'],
  ] as const;
  for (const [name, use] of astUnsupportedTaintCases) {
    it(`fails closed on CommonJS loader ${name}`, () => {
      assert.throws(
        () =>
          violationIn(
            "import { createRequire } from 'node:module';\n" +
              'const require = createRequire(import.meta.url);\n' +
              use
          ),
        /Unsupported/
      );
    });
  }

  it('fails closed on parenthesized eval', () => {
    assert.throws(
      () => violationIn('(eval)("require(\\\'../production/calculator.js\\\')");\n'),
      /Unsupported eval/
    );
  });

  const executableCodeGenerationCases = [
    [
      'Function-created dynamic import',
      "const load = Function('specifier', 'return import(specifier)');\n" +
        "void load('../production/calculator.js');\n",
    ],
    [
      'new Function constructor',
      "const load = new Function('specifier', 'return import(specifier)');\n" +
        "void load('../production/calculator.js');\n",
    ],
    [
      'aliased Function constructor',
      'const CodeGenerator = Function;\n' +
        "const load = CodeGenerator('specifier', 'return import(specifier)');\n" +
        "void load('../production/calculator.js');\n",
    ],
    [
      'global Function property',
      "const load = globalThis.Function('specifier', 'return import(specifier)');\n" +
        "void load('../production/calculator.js');\n",
    ],
    [
      'computed global Function property',
      "const load = globalThis['Function']('specifier', 'return import(specifier)');\n" +
        "void load('../production/calculator.js');\n",
    ],
    [
      'indirect eval alias',
      'const evaluate = eval;\n' +
        "evaluate(\"import('../production/calculator.ts')\");\n",
    ],
    [
      'global eval property',
      "globalThis.eval(\"import('../production/calculator.ts')\");\n",
    ],
    [
      'computed global eval property',
      "globalThis['eval'](\"import('../production/calculator.ts')\");\n",
    ],
    [
      'eval call helper',
      "eval.call(globalThis, \"import('../production/calculator.ts')\");\n",
    ],
    [
      'constructor-derived dynamic import',
      "const load = (() => {}).constructor('specifier', 'return import(specifier)');\n" +
        "void load('../production/calculator.js');\n",
    ],
    [
      'aliased constructor-derived dynamic import',
      'const functionValue = () => {};\n' +
        "const load = functionValue.constructor('specifier', 'return import(specifier)');\n" +
        "void load('../production/calculator.js');\n",
    ],
    [
      'dynamically computed global property',
      "globalThis['ev' + 'al'](\"import('../production/calculator.ts')\");\n",
    ],
    [
      'Reflect constructor lookup',
      "const make = Reflect.get(() => {}, 'constructor');\n" +
        "const load = make('specifier', 'return import(specifier)');\n" +
        "void load('../production/calculator.js');\n",
    ],
    [
      'global-qualified Reflect constructor lookup',
      "const make = globalThis.Reflect.get(() => {}, 'constructor');\n" +
        "const load = make('specifier', 'return import(specifier)');\n" +
        "void load('../production/calculator.js');\n",
    ],
    [
      'computed function constructor lookup',
      "const load = (() => {})['con' + 'structor']('specifier', 'return import(specifier)');\n" +
        "void load('../production/calculator.js');\n",
    ],
    [
      'Object descriptor constructor lookup',
      "const descriptor = Object.getOwnPropertyDescriptor(\n" +
        "  Object.getPrototypeOf(() => {}), 'constructor'\n" +
        ');\nvoid descriptor?.value;\n',
    ],
    [
      'global-qualified Object descriptor constructor lookup',
      "const descriptor = globalThis.Object.getOwnPropertyDescriptor(\n" +
        "  globalThis.Object.getPrototypeOf(() => {}), 'constructor'\n" +
        ');\nvoid descriptor?.value;\n',
    ],
    [
      'global-destructured Object descriptor constructor lookup',
      'const { Object: ObjectApi } = globalThis;\n' +
        "const descriptor = ObjectApi.getOwnPropertyDescriptor(\n" +
        "  ObjectApi.getPrototypeOf(() => {}), 'constructor'\n" +
        ');\nvoid descriptor?.value;\n',
    ],
    [
      'assignment-destructured Reflect constructor lookup',
      'let ReflectApi: typeof Reflect;\n({ Reflect: ReflectApi } = globalThis);\n' +
        "const make = ReflectApi.get(() => {}, 'constructor');\nvoid make;\n",
    ],
    [
      'aliased Object descriptor lookup',
      "const ObjectApi = Object;\nObjectApi.getPrototypeOf(() => {});\n",
    ],
    [
      'later-assigned Object descriptor lookup',
      "let ObjectApi: typeof Object;\nObjectApi = Object;\nObjectApi.getPrototypeOf(() => {});\n",
    ],
    [
      'conditional Object descriptor lookup',
      "const ObjectApi = true ? Object : {};\nObjectApi.getPrototypeOf(() => {});\n",
    ],
    [
      'comma-expression Object descriptor lookup',
      "const ObjectApi = (0, Object);\nObjectApi.getPrototypeOf(() => {});\n",
    ],
    [
      'nullish Object descriptor lookup',
      "const ObjectApi = Object ?? {};\nObjectApi.getPrototypeOf(() => {});\n",
    ],
    [
      'logical Object descriptor lookup',
      "const ObjectApi = Object || {};\nObjectApi.getPrototypeOf(() => {});\n",
    ],
    [
      'logical-assignment Object descriptor lookup',
      "let ObjectApi: typeof Object | undefined;\nObjectApi ??= Object;\nObjectApi.getPrototypeOf(() => {});\n",
    ],
    [
      'array-selected Object descriptor lookup',
      "const ObjectApi = [Object][0];\nObjectApi.getPrototypeOf(() => {});\n",
    ],
    [
      'object-binding default Object descriptor lookup',
      'const { safe: ObjectApi = Object } = {};\n' +
        "const descriptor = ObjectApi.getOwnPropertyDescriptor(\n" +
        "  ObjectApi.getPrototypeOf(() => {}), 'constructor'\n" +
        ');\nvoid descriptor?.value;\n',
    ],
    [
      'array-binding default Object descriptor lookup',
      'const [ObjectApi = Object] = [];\n' +
        "const descriptor = ObjectApi.getOwnPropertyDescriptor(\n" +
        "  ObjectApi.getPrototypeOf(() => {}), 'constructor'\n" +
        ');\nvoid descriptor?.value;\n',
    ],
    [
      'nested object-binding default Object descriptor lookup',
      'const { outer: { Object: ObjectApi } = globalThis } = {};\n' +
        "const descriptor = ObjectApi.getOwnPropertyDescriptor(\n" +
        "  ObjectApi.getPrototypeOf(() => {}), 'constructor'\n" +
        ');\nvoid descriptor?.value;\n',
    ],
    [
      'nested array-binding default Object descriptor lookup',
      'const { outer: [{ Object: ObjectApi }] = [globalThis] } = {};\n' +
        "const descriptor = ObjectApi.getOwnPropertyDescriptor(\n" +
        "  ObjectApi.getPrototypeOf(() => {}), 'constructor'\n" +
        ');\nvoid descriptor?.value;\n',
    ],
    [
      'parameter nested-binding default Object descriptor lookup',
      'const acquire = ({ outer: { Object: ObjectApi } = globalThis } = {}) =>\n' +
        "  ObjectApi.getOwnPropertyDescriptor(ObjectApi.getPrototypeOf(() => {}), 'constructor');\n" +
        'void acquire;\n',
    ],
    [
      'object-container Object descriptor lookup',
      'const bag = { api: Object };\nconst ObjectApi = bag.api;\n' +
        "ObjectApi.getPrototypeOf(() => {});\n",
    ],
    [
      'array-container Object descriptor lookup',
      'const bag = [Object];\nconst ObjectApi = bag[0];\n' +
        "ObjectApi.getPrototypeOf(() => {});\n",
    ],
    [
      'call-returned Object descriptor lookup',
      'const identity = <Value>(value: Value): Value => value;\n' +
        'const ObjectApi = identity(Object);\n' +
        "ObjectApi.getPrototypeOf(() => {});\n",
    ],
    [
      'named-function-returned Object descriptor lookup',
      'function acquireObject(): typeof Object { return Object; }\n' +
        'const ObjectApi = acquireObject();\n' +
        "ObjectApi.getPrototypeOf(() => {});\n",
    ],
    [
      'immediate-closure-returned Object descriptor lookup',
      'const ObjectApi = (() => Object)();\n' +
        "ObjectApi.getPrototypeOf(() => {});\n",
    ],
    [
      'getter-returned Object descriptor lookup',
      'const bag = { get api() { return Object; } };\n' +
        'const ObjectApi = bag.api;\n' +
        "ObjectApi.getPrototypeOf(() => {});\n",
    ],
    [
      'destructured-parameter-returned Object descriptor lookup',
      'const select = ({ api }: { api: typeof Object }): typeof Object => api;\n' +
        'const ObjectApi = select({ api: Object });\n' +
        "ObjectApi.getPrototypeOf(() => {});\n",
    ],
    [
      'ambiguous computed property lookup',
      "const key = 'constructor';\nvoid ({})[key];\n",
    ],
    [
      'Object reflection method destructuring',
      "const { getPrototypeOf: gp, getOwnPropertyDescriptor: gd } = Object;\n" +
        "const descriptor = gd(gp(() => {}), 'constructor');\n" +
        "void descriptor?.value;\n",
    ],
    [
      'parameter-default Object reflection destructuring',
      'const acquire = (\n' +
        '  { getPrototypeOf: gp, getOwnPropertyDescriptor: gd } = Object\n' +
        ") => gd(gp(() => {}), 'constructor');\nvoid acquire;\n",
    ],
    [
      'assignment Object reflection destructuring',
      'let gp: unknown;\nlet gd: unknown;\n' +
        '({ getPrototypeOf: gp, getOwnPropertyDescriptor: gd } = Object);\n',
    ],
    [
      'global Function destructuring',
      'const { Function: GeneratedFunction } = globalThis;\nvoid GeneratedFunction;\n',
    ],
  ] as const;
  for (const [name, source] of executableCodeGenerationCases) {
    it(`fails closed on ${name}`, () => {
      assert.throws(() => violationIn(source), /Unsupported/);
    });
  }

  const localCodeGeneratorNameCases = [
    ['local eval method', 'const metric = { eval: (value: number) => value };\nmetric.eval(1);\n'],
    [
      'local Function method',
      "const formatter = { Function: (value: string) => value };\nformatter.Function('ok');\n",
    ],
    [
      'shadowed Function binding',
      'const Function = (value: number): number => value;\nFunction(1);\n',
    ],
    ['shadowed eval binding', 'const eval = (value: number): number => value;\neval(1);\n'],
    ['ordinary Object.keys call', 'const values = Object.keys({ safe: true });\nvoid values;\n'],
    [
      'ordinary global-qualified Object.keys call',
      'const values = globalThis.Object.keys({ safe: true });\nvoid values;\n',
    ],
    ['numeric literal array access', 'const first = [1, 2][0];\nvoid first;\n'],
    ['safe Object.keys destructuring', 'const { keys } = Object;\nvoid keys;\n'],
    [
      'safe local destructuring default',
      'const { safe: LocalObject = { keys: Object.keys } } = {};\n' +
        'const values = LocalObject.keys({ safe: true });\nvoid values;\n',
    ],
    [
      'safe local object container',
      'const bag = { api: { keys: Object.keys } };\nconst LocalObject = bag.api;\n' +
        'const values = LocalObject.keys({ safe: true });\nvoid values;\n',
    ],
    [
      'safe local call result',
      'const identity = <Value>(value: Value): Value => value;\n' +
        'const LocalObject = identity({ keys: Object.keys });\n' +
        'const values = LocalObject.keys({ safe: true });\nvoid values;\n',
    ],
    [
      'safe local call that ignores an Object argument',
      'const makeLocalApi = (_ignored: unknown) => ({ getPrototypeOf: () => "local" });\n' +
        'const value = makeLocalApi(Object).getPrototypeOf();\nvoid value;\n',
    ],
    [
      'local destructured Function member',
      "const formatter = { Function: (value: string) => value };\n" +
        "const { Function } = formatter;\nFunction('ok');\n",
    ],
    [
      'renamed local destructured Function member',
      "const formatter = { Function: (value: string) => value };\n" +
        "const { Function: LocalFunction } = formatter;\nLocalFunction('ok');\n",
    ],
    [
      'renamed local destructured eval member',
      'const metric = { eval: (value: number) => value };\n' +
        'const { eval: localEval } = metric;\nlocalEval(1);\n',
    ],
    [
      'renamed local destructured Reflect member',
      "const box = { Reflect: { get: (_value: unknown, key: string) => key } };\n" +
        "const { Reflect: LocalReflect } = box;\nLocalReflect.get({}, 'safe');\n",
    ],
    [
      'shadowed Reflect binding',
      "const Reflect = { get: (_value: unknown, key: string) => key };\nReflect.get({}, 'safe');\n",
    ],
  ] as const;
  for (const [name, source] of localCodeGeneratorNameCases) {
    it(`accepts ${name}`, () => {
      assert.equal(violationIn(source), null);
    });
  }

  it('fails closed when the source has TypeScript parse diagnostics', () => {
    assert.throws(
      () => violationIn("import { calculateBenefit from '../production/calculator.ts';\n"),
      /Unable to parse calculation assurance evidence/
    );
  });

  it('tracks a local helper that re-exports createRequire', () => {
    const content = new Map([
      [
        'oracle/violatingOracle.test.ts',
        "import { createRequire } from '../shared/createRequire.ts';\n" +
          'const req = createRequire(import.meta.url);\n' +
          "req('../production/calculator.js');\n",
      ],
      ['shared/createRequire.ts', "export { createRequire } from 'node:module';\n"],
      [productionPath, 'export const calculateBenefit = (): number => 0;\n'],
    ]);
    assert.equal(
      findImportedImplementationFileFromContent(
        'oracle/violatingOracle.test.ts',
        content,
        isProductionCalculatorPath
      ),
      productionPath
    );
  });

  it('does not fail closed on a createRequire call whose result is never bound to an alias', () => {
    // `.resolve` and similar member access on the createRequire result do not load a module, so a
    // call with no recognizable alias assignment is left alone rather than guessed at.
    assert.equal(
      violationIn(
        "import { createRequire } from 'node:module';\n" +
          "const resolved = createRequire(import.meta.url).resolve('../production/calculator.js');\n" +
          'void resolved;\n'
      ),
      null
    );
  });
});
