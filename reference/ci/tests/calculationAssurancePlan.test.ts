import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';

import {
  calculationAssuranceRegistry,
  calculationAssuranceSelectionPaths,
  deriveCalculationAssurancePlan,
  selectCalculationAssurancePackageIds,
} from '../src/calculationAssurancePlan.ts';

const fixtureRepoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  'fixtures/assurance-registry-repo'
);

function fixtureRegistry(independentOracle: string, implementationFile = 'implementation/calculator.ts') {
  return {
    schema: 'example.calculation-assurance-registry.v1' as const,
    rollout: 'enforce' as const,
    packages: [
      {
        id: 'fixture-benefit',
        risk: 'regulated-financial-output' as const,
        status: 'enforced' as const,
        implementationSelectors: [{ kind: 'file' as const, value: implementationFile }],
        evidenceSelectors: [
          { kind: 'prefix' as const, value: 'server/tests/assurance/fixture-benefit/' },
        ],
        sources: [{ authority: 'federal' as const, url: 'https://example.gov/rule' }],
        tests: {
          ruleVectors: ['server/tests/assurance/fixture-benefit/ruleVectors.test.ts'],
          independentOracle: [independentOracle],
          metamorphicProperties: ['server/tests/assurance/fixture-benefit/properties.test.ts'],
          mutationSentinels: ['server/tests/assurance/fixture-benefit/mutations.test.ts'],
        },
      },
    ],
  };
}

describe('deriveCalculationAssurancePlan import-graph boundary', () => {
  it('rejects an enforced package whose evidence test directly imports its production calculator', () => {
    assert.throws(
      () =>
        deriveCalculationAssurancePlan(
          [],
          fixtureRegistry('server/tests/assurance/fixture-benefit/oracleDirect.test.ts'),
          fixtureRepoRoot
        ),
      /imports production calculator module implementation\/calculator\.ts/
    );
  });

  it('rejects an enforced package whose evidence test imports its production calculator through a shared helper', () => {
    assert.throws(
      () =>
        deriveCalculationAssurancePlan(
          [],
          fixtureRegistry('server/tests/assurance/fixture-benefit/oracleIndirect.test.ts'),
          fixtureRepoRoot
        ),
      /imports production calculator module implementation\/calculator\.ts/
    );
  });

  it('accepts an enforced package whose evidence test does not import its production calculator', () => {
    const plan = deriveCalculationAssurancePlan(
      [],
      fixtureRegistry('server/tests/assurance/fixture-benefit/oracleClean.test.ts'),
      fixtureRepoRoot
    );

    assert.deepEqual(plan.selectedPackages, []);
  });

  it('rejects an evidence test that directly imports the projection tax dollar basis calculator', () => {
    assert.throws(
      () =>
        deriveCalculationAssurancePlan(
          [],
          fixtureRegistry(
            'server/tests/assurance/fixture-benefit/oracleProjectionDirect.test.ts',
            'implementation/projectionTaxDollarBasis.ts'
          ),
          fixtureRepoRoot
        ),
      /imports production calculator module implementation\/projectionTaxDollarBasis\.ts/
    );
  });

  it('validates the exact-head evidence content instead of a stale trusted-base checkout', () => {
    // fixtureRepoRoot's copy of oracleClean.test.ts genuinely does not import the calculator, but
    // a trusted-base CI checkout only ever sees that stale copy. Supplying verified exact-head
    // content that DOES import it must still be rejected, proving the check no longer trusts
    // repoRoot once independently verified content is available.
    const evidenceContent = new Map([
      ['server/tests/assurance/fixture-benefit/ruleVectors.test.ts', 'export {};\n'],
      [
        'server/tests/assurance/fixture-benefit/oracleClean.test.ts',
        "import { calculateBenefit } from '../../../../implementation/calculator.ts';\n\ncalculateBenefit(100);\n",
      ],
      ['server/tests/assurance/fixture-benefit/properties.test.ts', 'export {};\n'],
      ['server/tests/assurance/fixture-benefit/mutations.test.ts', 'export {};\n'],
      ['implementation/calculator.ts', 'export function calculateBenefit(income) { return income * 0.1; }\n'],
    ]);

    assert.throws(
      () =>
        deriveCalculationAssurancePlan(
          ['implementation/calculator.ts'],
          fixtureRegistry('server/tests/assurance/fixture-benefit/oracleClean.test.ts'),
          fixtureRepoRoot,
          evidenceContent
        ),
      /imports production calculator module implementation\/calculator\.ts/
    );
  });
});

describe('deriveCalculationAssurancePlan', () => {
  it('skips unrelated application changes', () => {
    const plan = deriveCalculationAssurancePlan(
      ['src/components/ProfileHeader.tsx'],
      calculationAssuranceRegistry
    );

    assert.equal(plan.mode, 'skip');
    assert.deepEqual(plan.selectedPackages, []);
    assert.equal(plan.independentAuditRequired, false);
  });

  it('surfaces incomplete assurance layers for an affected high-risk calculation', () => {
    const plan = deriveCalculationAssurancePlan(
      ['server/services/chat/rules/socialSecurityEvidenceRules.ts'],
      calculationAssuranceRegistry
    );

    assert.equal(plan.mode, 'shadow');
    assert.deepEqual(plan.selectedPackages, ['social-security-benefits']);
    assert.equal(plan.independentAuditRequired, true);
    assert.deepEqual(plan.gaps, [
      'social-security-benefits:authoritative-rule-vectors',
      'social-security-benefits:independent-oracle',
      'social-security-benefits:metamorphic-properties',
      'social-security-benefits:mutation-sentinels',
    ]);
  });

  it('selects every calculation package owned by a shared implementation file', () => {
    const plan = deriveCalculationAssurancePlan(
      ['server/services/chat/tools/registry.ts'],
      calculationAssuranceRegistry
    );

    assert.deepEqual(plan.selectedPackages, ['multi-year-tax', 'social-security-benefits']);
  });

  it('selects every calculation package owned by the canonical financial constants module', () => {
    const plan = deriveCalculationAssurancePlan(
      ['server/services/shared/financialConstants.ts'],
      calculationAssuranceRegistry
    );

    assert.deepEqual(plan.selectedPackages, ['multi-year-tax', 'social-security-benefits']);
    assert.equal(plan.independentAuditRequired, true);
  });

  it('selects the multi-year-tax package when the projection tax dollar basis calculator changes', () => {
    const plan = deriveCalculationAssurancePlan(
      ['server/services/planning/projectionTaxDollarBasis.ts'],
      calculationAssuranceRegistry
    );

    assert.equal(plan.mode, 'shadow');
    assert.deepEqual(plan.selectedPackages, ['multi-year-tax']);
    assert.equal(plan.independentAuditRequired, true);
  });

  it('selects the multi-year-tax package when the shared tax utility calculator changes', () => {
    const plan = deriveCalculationAssurancePlan(
      ['server/utils/taxUtils.ts'],
      calculationAssuranceRegistry
    );

    assert.equal(plan.mode, 'shadow');
    assert.deepEqual(plan.selectedPackages, ['multi-year-tax']);
    assert.equal(plan.independentAuditRequired, true);
  });

  it('selects every package owned by the net worth projection calculator', () => {
    // retirementTimingEngine.ts calls calculateRetirementProjection from this module, so a Social
    // Security claiming-age benefit moves with it even though no social-security-benefits file is
    // touched.
    const plan = deriveCalculationAssurancePlan(
      ['server/services/planning/netWorthProjectionService.ts'],
      calculationAssuranceRegistry
    );

    assert.equal(plan.mode, 'shadow');
    assert.deepEqual(plan.selectedPackages, ['multi-year-tax', 'social-security-benefits']);
    assert.equal(plan.independentAuditRequired, true);
    assert.ok(plan.gaps.includes('social-security-benefits:independent-oracle'));
  });

  it('selects a package whose registered calculator the change renamed away', () => {
    // A rename reports only its new path as changed, so selecting on changed paths alone let a PR
    // move a registered calculator out from under every selector and skip assurance entirely.
    const plan = deriveCalculationAssurancePlan(
      calculationAssuranceSelectionPaths(
        ['server/services/engines/taxEstimatorEngineV2.ts'],
        ['server/services/engines/taxEstimatorEngine.ts']
      ),
      calculationAssuranceRegistry
    );

    assert.equal(plan.mode, 'shadow');
    assert.deepEqual(plan.selectedPackages, ['multi-year-tax']);
    assert.equal(plan.independentAuditRequired, true);
  });

  it('selects a package whose registered calculator the change deleted outright', () => {
    const plan = deriveCalculationAssurancePlan(
      calculationAssuranceSelectionPaths(
        ['server/services/shared/taxConstants.ts'],
        ['server/services/shared/taxConstants.ts']
      ),
      calculationAssuranceRegistry
    );

    assert.deepEqual(plan.selectedPackages, ['multi-year-tax', 'social-security-benefits']);
  });

  it('selects the multi-year-tax package when the tax bucket service changes directly', () => {
    // Regression: this file feeds netWorthProjectionService.ts's tax calculation and must not be
    // editable without triggering assurance, even when the file that imports it is untouched.
    const plan = deriveCalculationAssurancePlan(
      ['server/services/planning/projectionTaxBucketService.ts'],
      calculationAssuranceRegistry
    );

    assert.deepEqual(plan.selectedPackages, ['multi-year-tax']);
  });

  it('selects the multi-year-tax package when projected withdrawal policy changes', () => {
    // The tax bucket service delegates age, date, Roth-basis, and penalty treatment to this
    // module, so it belongs to the same regulated-output boundary as the bucket calculator.
    const plan = deriveCalculationAssurancePlan(
      ['server/services/planning/projectedWithdrawalPolicy.ts'],
      calculationAssuranceRegistry
    );

    assert.equal(plan.mode, 'shadow');
    assert.deepEqual(plan.selectedPackages, ['multi-year-tax']);
    assert.equal(plan.independentAuditRequired, true);
  });

  it('selects every calculation package owned by the canonical tax constants module', () => {
    const plan = deriveCalculationAssurancePlan(
      ['server/services/shared/taxConstants.ts'],
      calculationAssuranceRegistry
    );

    assert.deepEqual(plan.selectedPackages, ['multi-year-tax', 'social-security-benefits']);
  });

  it('keeps existing tests inside the independent-audit boundary', () => {
    const plan = deriveCalculationAssurancePlan(
      ['server/tests/getSocialSecurityEstimateTool.test.ts'],
      calculationAssuranceRegistry
    );

    assert.deepEqual(plan.selectedPackages, ['social-security-benefits']);
    assert.equal(plan.independentAuditRequired, true);
  });

  it('returns the exact economical test set for an enforced contract', () => {
    const evidenceContent = new Map([
      ['server/tests/assurance/example-benefit/ruleVectors.test.ts', ''],
      ['server/tests/assurance/example-benefit/oracle.test.ts', ''],
      ['server/tests/assurance/example-benefit/properties.test.ts', ''],
      ['server/tests/assurance/example-benefit/mutations.test.ts', ''],
    ]);
    const plan = deriveCalculationAssurancePlan(
      ['server/services/example/calculateBenefit.ts'],
      {
        schema: 'example.calculation-assurance-registry.v1',
        rollout: 'enforce',
        packages: [
          {
            id: 'example-benefit',
            risk: 'regulated-financial-output',
            status: 'enforced',
            implementationSelectors: [
              {
                kind: 'prefix',
                value: 'server/services/example/',
              },
            ],
            evidenceSelectors: [
              {
                kind: 'prefix',
                value: 'server/tests/assurance/example-benefit/',
              },
            ],
            sources: [
              {
                authority: 'federal',
                url: 'https://example.gov/rule',
              },
            ],
            tests: {
              ruleVectors: ['server/tests/assurance/example-benefit/ruleVectors.test.ts'],
              independentOracle: ['server/tests/assurance/example-benefit/oracle.test.ts'],
              metamorphicProperties: ['server/tests/assurance/example-benefit/properties.test.ts'],
              mutationSentinels: ['server/tests/assurance/example-benefit/mutations.test.ts'],
            },
          },
        ],
      },
      process.cwd(),
      evidenceContent
    );

    assert.equal(plan.mode, 'enforce');
    assert.deepEqual(plan.targetedTests, [
      'server/tests/assurance/example-benefit/mutations.test.ts',
      'server/tests/assurance/example-benefit/oracle.test.ts',
      'server/tests/assurance/example-benefit/properties.test.ts',
      'server/tests/assurance/example-benefit/ruleVectors.test.ts',
    ]);
  });

  it('rejects duplicate package identities at the untyped boundary', () => {
    const duplicate = calculationAssuranceRegistry.packages[0];
    assert.ok(duplicate);

    assert.throws(
      () =>
        deriveCalculationAssurancePlan(['server/services/chat/tools/registry.ts'], {
          ...calculationAssuranceRegistry,
          packages: [duplicate, duplicate],
        }),
      /Duplicate calculation assurance package/
    );
  });

  it('rejects overlapping implementation and evidence selectors', () => {
    assert.throws(
      () =>
        deriveCalculationAssurancePlan(['server/services/example/calculateBenefit.ts'], {
          schema: 'example.calculation-assurance-registry.v1',
          rollout: 'shadow',
          packages: [
            {
              id: 'example-benefit',
              risk: 'regulated-financial-output',
              status: 'enforced',
              implementationSelectors: [
                {
                  kind: 'file',
                  value: 'server/services/example/calculateBenefit.ts',
                },
              ],
              evidenceSelectors: [
                {
                  kind: 'file',
                  value: 'server/services/example/calculateBenefit.ts',
                },
              ],
              sources: [
                {
                  authority: 'federal',
                  url: 'https://example.gov/rule',
                },
              ],
              tests: {
                ruleVectors: ['server/tests/assurance/example/ruleVectors.test.ts'],
                independentOracle: ['server/tests/assurance/example/oracle.test.ts'],
                metamorphicProperties: ['server/tests/assurance/example/properties.test.ts'],
                mutationSentinels: ['server/tests/assurance/example/mutations.test.ts'],
              },
            },
          ],
        }),
      /overlapping implementation and evidence selector/
    );
  });

  it('rejects an enforced test outside its isolated assurance package', () => {
    assert.throws(
      () =>
        deriveCalculationAssurancePlan(['server/services/example/calculateBenefit.ts'], {
          schema: 'example.calculation-assurance-registry.v1',
          rollout: 'enforce',
          packages: [
            {
              id: 'example-benefit',
              risk: 'regulated-financial-output',
              status: 'enforced',
              implementationSelectors: [
                {
                  kind: 'prefix',
                  value: 'server/services/example/',
                },
              ],
              evidenceSelectors: [
                {
                  kind: 'prefix',
                  value: 'server/tests/assurance/example-benefit/',
                },
              ],
              sources: [
                {
                  authority: 'federal',
                  url: 'https://example.gov/rule',
                },
              ],
              tests: {
                ruleVectors: ['server/tests/exampleMirrorsProduction.test.ts'],
                independentOracle: ['server/tests/assurance/example-benefit/oracle.test.ts'],
                metamorphicProperties: [
                  'server/tests/assurance/example-benefit/properties.test.ts',
                ],
                mutationSentinels: ['server/tests/assurance/example-benefit/mutations.test.ts'],
              },
            },
          ],
        }),
      /outside its isolated assurance package/
    );
  });

  it('rejects an enforced test inside the assurance directory but uncovered by any evidence selector', () => {
    const evidenceContent = new Map([
      ['server/tests/assurance/example-benefit/rule-vectors/ruleVectors.test.ts', ''],
    ]);
    assert.throws(
      () =>
        deriveCalculationAssurancePlan(
          ['server/services/example/calculateBenefit.ts'],
          {
            schema: 'example.calculation-assurance-registry.v1',
            rollout: 'enforce',
            packages: [
              {
                id: 'example-benefit',
                risk: 'regulated-financial-output',
                status: 'enforced',
                implementationSelectors: [
                  {
                    kind: 'prefix',
                    value: 'server/services/example/',
                  },
                ],
                evidenceSelectors: [
                  {
                    kind: 'prefix',
                    value: 'server/tests/assurance/example-benefit/rule-vectors/',
                  },
                ],
                sources: [
                  {
                    authority: 'federal',
                    url: 'https://example.gov/rule',
                  },
                ],
                tests: {
                  ruleVectors: [
                    'server/tests/assurance/example-benefit/rule-vectors/ruleVectors.test.ts',
                  ],
                  independentOracle: ['server/tests/assurance/example-benefit/oracle.test.ts'],
                  metamorphicProperties: [
                    'server/tests/assurance/example-benefit/properties.test.ts',
                  ],
                  mutationSentinels: ['server/tests/assurance/example-benefit/mutations.test.ts'],
                },
              },
            ],
          },
          process.cwd(),
          evidenceContent
        ),
      /not covered by any evidence selector/
    );
  });

  it('rejects an enforced package whose declared evidence test does not exist at this revision', () => {
    assert.throws(
      () =>
        deriveCalculationAssurancePlan(
          ['server/services/example/calculateBenefit.ts'],
          {
            schema: 'example.calculation-assurance-registry.v1',
            rollout: 'enforce',
            packages: [
              {
                id: 'example-benefit',
                risk: 'regulated-financial-output',
                status: 'enforced',
                implementationSelectors: [
                  { kind: 'prefix', value: 'server/services/example/' },
                ],
                evidenceSelectors: [
                  { kind: 'prefix', value: 'server/tests/assurance/example-benefit/' },
                ],
                sources: [{ authority: 'federal', url: 'https://example.gov/rule' }],
                tests: {
                  ruleVectors: ['server/tests/assurance/example-benefit/ruleVectors.test.ts'],
                  independentOracle: ['server/tests/assurance/example-benefit/oracle.test.ts'],
                  metamorphicProperties: [
                    'server/tests/assurance/example-benefit/properties.test.ts',
                  ],
                  mutationSentinels: ['server/tests/assurance/example-benefit/mutations.test.ts'],
                },
              },
            ],
          },
          process.cwd(),
          new Map()
        ),
      /declares an evidence test that does not exist at this revision: server\/tests\/assurance\/example-benefit\/ruleVectors\.test\.ts/
    );
  });

  it('rejects an enforced evidence test declared for the exact PR head but absent from verified content, even when it still exists in the trusted-base checkout', () => {
    // Guards the core of the trusted-base-checkout gap: repoRoot here is the real repo, where the
    // fixture-benefit registry's evidence files genuinely exist on disk. A caller that supplies
    // verified exact-head content must not fall back to that disk state for files the fetch
    // confirmed are missing from the PR head (e.g. deleted or renamed by the PR).
    assert.throws(
      () =>
        deriveCalculationAssurancePlan(
          ['implementation/calculator.ts'],
          fixtureRegistry('server/tests/assurance/fixture-benefit/oracleClean.test.ts'),
          fixtureRepoRoot,
          new Map()
        ),
      /declares an evidence test that does not exist at this revision/
    );
  });

  it('does not require fetched evidence for a package the change never selected', () => {
    // Evidence content is fetched only for selected packages, so an unselected package's declared
    // evidence is absent by design and must not be read as missing from the head.
    const plan = deriveCalculationAssurancePlan(
      ['docs/unrelated.md'],
      fixtureRegistry('server/tests/assurance/fixture-benefit/oracleClean.test.ts'),
      fixtureRepoRoot,
      new Map()
    );

    assert.equal(plan.mode, 'skip');
    assert.deepEqual(plan.selectedPackages, []);
  });

  it('still validates the evidence of a selected package when another package is unselected', () => {
    const registry = fixtureRegistry('server/tests/assurance/fixture-benefit/oracleClean.test.ts');
    const unselected = {
      id: 'other-benefit',
      risk: 'regulated-financial-output' as const,
      status: 'enforced' as const,
      implementationSelectors: [{ kind: 'file' as const, value: 'implementation/other.ts' }],
      evidenceSelectors: [
        { kind: 'prefix' as const, value: 'server/tests/assurance/other-benefit/' },
      ],
      sources: [{ authority: 'federal' as const, url: 'https://example.gov/other' }],
      tests: {
        ruleVectors: ['server/tests/assurance/other-benefit/ruleVectors.test.ts'],
        independentOracle: ['server/tests/assurance/other-benefit/oracle.test.ts'],
        metamorphicProperties: ['server/tests/assurance/other-benefit/properties.test.ts'],
        mutationSentinels: ['server/tests/assurance/other-benefit/mutations.test.ts'],
      },
    };

    assert.throws(
      () =>
        deriveCalculationAssurancePlan(
          ['implementation/calculator.ts'],
          { ...registry, packages: [...registry.packages, unselected] },
          fixtureRepoRoot,
          new Map()
        ),
      /fixture-benefit declares an evidence test that does not exist at this revision/
    );
  });
});

describe('calculationAssuranceSelectionPaths', () => {
  it('unions changed paths with the previous paths a rename removed', () => {
    assert.deepEqual(
      calculationAssuranceSelectionPaths(['server/services/b.ts'], ['server/services/a.ts']),
      ['server/services/b.ts', 'server/services/a.ts']
    );
  });

  it('reports a path that was both changed and deleted exactly once', () => {
    assert.deepEqual(
      calculationAssuranceSelectionPaths(['server/services/a.ts'], ['server/services/a.ts']),
      ['server/services/a.ts']
    );
  });
});

describe('selectCalculationAssurancePackageIds', () => {
  it('returns nothing for changes that do not select any package, requiring zero evidence fetches', () => {
    const registry = fixtureRegistry('server/tests/assurance/fixture-benefit/oracle.test.ts');

    assert.deepEqual(selectCalculationAssurancePackageIds(['README.md'], registry), []);
  });

  it('returns the package whose implementation selector a changed file matches', () => {
    const registry = fixtureRegistry('server/tests/assurance/fixture-benefit/oracle.test.ts');

    assert.deepEqual(selectCalculationAssurancePackageIds(['implementation/calculator.ts'], registry), [
      'fixture-benefit',
    ]);
  });

  it('returns the package whose evidence selector a changed file matches', () => {
    const registry = fixtureRegistry('server/tests/assurance/fixture-benefit/oracle.test.ts');

    assert.deepEqual(
      selectCalculationAssurancePackageIds(
        ['server/tests/assurance/fixture-benefit/oracle.test.ts'],
        registry
      ),
      ['fixture-benefit']
    );
  });

  it('returns the package a rename moved a registered calculator away from', () => {
    const registry = fixtureRegistry('server/tests/assurance/fixture-benefit/oracle.test.ts');

    assert.deepEqual(
      selectCalculationAssurancePackageIds(
        calculationAssuranceSelectionPaths(
          ['implementation/renamedCalculator.ts'],
          ['implementation/calculator.ts']
        ),
        registry
      ),
      ['fixture-benefit']
    );
  });

  it('returns nothing for the real registry when changed files are unrelated to every package', () => {
    assert.deepEqual(
      selectCalculationAssurancePackageIds(
        ['src/components/Example.tsx'],
        calculationAssuranceRegistry
      ),
      []
    );
  });

  it('returns the multi-year-tax package when the newly-covered tax bucket service changes', () => {
    assert.deepEqual(
      selectCalculationAssurancePackageIds(
        ['server/services/planning/projectionTaxBucketService.ts'],
        calculationAssuranceRegistry
      ),
      ['multi-year-tax']
    );
  });

  it('returns both real packages, sorted, when a shared constants module changes', () => {
    assert.deepEqual(
      selectCalculationAssurancePackageIds(
        ['server/services/shared/financialConstants.ts'],
        calculationAssuranceRegistry
      ),
      ['multi-year-tax', 'social-security-benefits']
    );
  });
});
