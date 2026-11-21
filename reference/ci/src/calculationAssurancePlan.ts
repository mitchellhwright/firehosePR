import { existsSync, statSync } from 'node:fs';
import nodePath from 'node:path';

import { z } from 'zod';

import {
  findImportedImplementationFile,
  findImportedImplementationFileFromContent,
} from './assuranceImportGraph.ts';

const evidenceLayerSchema = z.enum([
  'authoritative-rule-vectors',
  'independent-oracle',
  'metamorphic-properties',
  'mutation-sentinels',
]);

const fileSelectorSchema = z
  .object({
    kind: z.literal('file'),
    value: z.string().min(1),
  })
  .strict();

const prefixSelectorSchema = z
  .object({
    kind: z.literal('prefix'),
    value: z
      .string()
      .min(1)
      .refine((value) => value.endsWith('/'), {
        message: 'Prefix selectors must end with /',
      }),
  })
  .strict();

const pathSelectorSchema = z.discriminatedUnion('kind', [fileSelectorSchema, prefixSelectorSchema]);
type PathSelector = z.infer<typeof pathSelectorSchema>;

const sourceSchema = z
  .object({
    authority: z.enum(['federal', 'state', 'standards-body', 'product-policy']),
    url: z
      .string()
      .url()
      .refine((value) => value.startsWith('https://'), {
        message: 'Calculation sources must use HTTPS',
      }),
  })
  .strict();

const packageBase = {
  id: z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/),
  risk: z.literal('regulated-financial-output'),
  implementationSelectors: z.array(pathSelectorSchema).min(1),
};

const inventoryPackageSchema = z
  .object({
    ...packageBase,
    status: z.literal('inventory'),
    knownTestPaths: z.array(z.string().min(1)).min(1),
    missingLayers: z.array(evidenceLayerSchema).min(1),
  })
  .strict();

const enforcedPackageSchema = z
  .object({
    ...packageBase,
    status: z.literal('enforced'),
    evidenceSelectors: z.array(pathSelectorSchema).min(1),
    sources: z.array(sourceSchema).min(1),
    tests: z
      .object({
        ruleVectors: z.array(z.string().min(1)).min(1),
        independentOracle: z.array(z.string().min(1)).min(1),
        metamorphicProperties: z.array(z.string().min(1)).min(1),
        mutationSentinels: z.array(z.string().min(1)).min(1),
      })
      .strict(),
  })
  .strict();

const calculationPackageSchema = z.discriminatedUnion('status', [
  inventoryPackageSchema,
  enforcedPackageSchema,
]);
type CalculationPackage = z.infer<typeof calculationPackageSchema>;

export const calculationAssuranceRegistrySchema = z
  .object({
    schema: z.literal('example.calculation-assurance-registry.v1'),
    rollout: z.enum(['shadow', 'enforce']),
    packages: z.array(calculationPackageSchema).min(1),
  })
  .strict();
export type CalculationAssuranceRegistry = z.input<typeof calculationAssuranceRegistrySchema>;

export const calculationAssurancePlanSchema = z.object({
  schema: z.literal('example.calculation-assurance-plan.v1'),
  mode: z.enum(['skip', 'shadow', 'enforce']),
  selectedPackages: z.array(z.string()),
  independentAuditRequired: z.boolean(),
  targetedTests: z.array(z.string()),
  gaps: z.array(z.string()),
  reasons: z.array(z.string()),
});
export type CalculationAssurancePlan = z.infer<typeof calculationAssurancePlanSchema>;

const allEvidenceLayers = evidenceLayerSchema.options;

export const calculationAssuranceRegistry = {
  schema: 'example.calculation-assurance-registry.v1',
  rollout: 'shadow',
  packages: [
    {
      id: 'multi-year-tax',
      risk: 'regulated-financial-output',
      status: 'inventory',
      implementationSelectors: [
        { kind: 'file', value: 'server/services/chat/rag/agents/taxTools.ts' },
        { kind: 'file', value: 'server/services/chat/tools/registry.ts' },
        { kind: 'file', value: 'server/services/engines/taxEstimatorEngine.ts' },
        { kind: 'file', value: 'server/services/planning/netWorthProjectionService.ts' },
        { kind: 'file', value: 'server/services/planning/projectedWithdrawalPolicy.ts' },
        { kind: 'file', value: 'server/services/planning/projectionTaxBucketService.ts' },
        { kind: 'file', value: 'server/services/planning/projectionTaxDollarBasis.ts' },
        { kind: 'prefix', value: 'server/services/retirement/' },
        { kind: 'file', value: 'server/services/shared/financialConstants.ts' },
        { kind: 'file', value: 'server/services/shared/taxConstants.ts' },
        { kind: 'file', value: 'server/utils/taxUtils.ts' },
      ],
      knownTestPaths: [
        'server/tests/taxEstimatorEngine.test.ts',
        'server/tests/taxTools.test.ts',
        'server/tests/retirementWithdrawalTax.test.ts',
      ],
      missingLayers: allEvidenceLayers,
    },
    {
      id: 'social-security-benefits',
      risk: 'regulated-financial-output',
      status: 'inventory',
      implementationSelectors: [
        { kind: 'file', value: 'server/services/chat/rules/socialSecurityEvidenceRules.ts' },
        { kind: 'file', value: 'server/services/chat/tools/registry.ts' },
        { kind: 'file', value: 'server/services/engines/retirementTimingEngine.ts' },
        // retirementTimingEngine.ts calls calculateRetirementProjection from this module, so a
        // claiming-age benefit changes with it even when no file above is touched.
        { kind: 'file', value: 'server/services/planning/netWorthProjectionService.ts' },
        { kind: 'file', value: 'server/services/shared/financialConstants.ts' },
        { kind: 'file', value: 'server/services/shared/taxConstants.ts' },
      ],
      knownTestPaths: [
        'server/tests/getSocialSecurityEstimateTool.test.ts',
        'server/tests/socialSecurityEvidenceRules.test.ts',
        'server/tests/retirementTimingEngine.test.ts',
      ],
      missingLayers: allEvidenceLayers,
    },
  ],
} as const satisfies CalculationAssuranceRegistry;

function matches(selector: PathSelector, path: string): boolean {
  switch (selector.kind) {
    case 'file':
      return path === selector.value;
    case 'prefix':
      return path.startsWith(selector.value);
  }
}

function selectorsOverlap(left: PathSelector, right: PathSelector): boolean {
  if (left.kind === 'file' && right.kind === 'file') {
    return left.value === right.value;
  }
  if (left.kind === 'prefix' && right.kind === 'prefix') {
    return left.value.startsWith(right.value) || right.value.startsWith(left.value);
  }
  const file = left.kind === 'file' ? left.value : right.value;
  const prefix = left.kind === 'prefix' ? left.value : right.value;
  return file.startsWith(prefix);
}

function evidenceFileExists(
  repoRoot: string,
  evidenceContent: ReadonlyMap<string, string> | undefined,
  testPath: string
): boolean {
  if (evidenceContent) return evidenceContent.has(testPath);
  const absolute = nodePath.resolve(repoRoot, testPath);
  return existsSync(absolute) && statSync(absolute).isFile();
}

/**
 * @param contentBackedPackageIds Packages whose evidence `evidenceContent` actually covers, or
 *   `null` when `repoRoot` supplies every package's evidence. Fetched content is scoped to the
 *   packages the change selects, so an unselected package's evidence is absent by design and must
 *   not be read as missing at the head.
 */
function validateRegistry(
  packages: readonly CalculationPackage[],
  repoRoot: string,
  evidenceContent: ReadonlyMap<string, string> | undefined,
  contentBackedPackageIds: ReadonlySet<string> | null
): void {
  const ids = new Set<string>();
  for (const calculationPackage of packages) {
    if (ids.has(calculationPackage.id)) {
      throw new Error(`Duplicate calculation assurance package: ${calculationPackage.id}`);
    }
    ids.add(calculationPackage.id);

    if (calculationPackage.status !== 'enforced') continue;
    const evidenceIsAvailable =
      contentBackedPackageIds === null || contentBackedPackageIds.has(calculationPackage.id);
    for (const implementation of calculationPackage.implementationSelectors) {
      for (const evidence of calculationPackage.evidenceSelectors) {
        if (selectorsOverlap(implementation, evidence)) {
          throw new Error(
            `${calculationPackage.id} has an overlapping implementation and evidence selector`
          );
        }
      }
    }
    const assuranceRoot = `server/tests/assurance/${calculationPackage.id}/`;
    const testPaths = [
      ...calculationPackage.tests.ruleVectors,
      ...calculationPackage.tests.independentOracle,
      ...calculationPackage.tests.metamorphicProperties,
      ...calculationPackage.tests.mutationSentinels,
    ];
    const isImplementationPath = (candidate: string): boolean =>
      calculationPackage.implementationSelectors.some((selector) => matches(selector, candidate));
    for (const testPath of testPaths) {
      if (!testPath.startsWith(assuranceRoot)) {
        throw new Error(
          `${calculationPackage.id} test is outside its isolated assurance package: ${testPath}`
        );
      }
      const covered = calculationPackage.evidenceSelectors.some((selector) =>
        matches(selector, testPath)
      );
      if (!covered) {
        throw new Error(
          `${calculationPackage.id} test is not covered by any evidence selector: ${testPath}`
        );
      }
      if (!evidenceIsAvailable) continue;
      if (!evidenceFileExists(repoRoot, evidenceContent, testPath)) {
        throw new Error(
          `${calculationPackage.id} declares an evidence test that does not exist at this revision: ${testPath}`
        );
      }
      const importedImplementation = evidenceContent
        ? findImportedImplementationFileFromContent(testPath, evidenceContent, isImplementationPath)
        : findImportedImplementationFile(repoRoot, testPath, isImplementationPath);
      if (importedImplementation !== null) {
        throw new Error(
          `${calculationPackage.id} evidence test ${testPath} imports production calculator ` +
            `module ${importedImplementation}, which breaks independent-evidence isolation`
        );
      }
    }
  }
}

function selectorsForPackage(calculationPackage: CalculationPackage): readonly PathSelector[] {
  return calculationPackage.status === 'enforced'
    ? [...calculationPackage.implementationSelectors, ...calculationPackage.evidenceSelectors]
    : [
        ...calculationPackage.implementationSelectors,
        ...calculationPackage.knownTestPaths.map((value) => ({
          kind: 'file' as const,
          value,
        })),
      ];
}

function packageIsSelected(
  calculationPackage: CalculationPackage,
  selectionPaths: readonly string[]
): boolean {
  const selectors = selectorsForPackage(calculationPackage);
  return selectionPaths.some((path) => selectors.some((selector) => matches(selector, path)));
}

/**
 * Every repo-relative path a change touches, for assurance selection purposes: the paths present
 * at the head unioned with the paths the change removed. A rename reports only its new path as
 * changed and its previous path as deleted, so selecting on changed paths alone lets a PR move a
 * registered calculator out from under every selector and skip assurance entirely.
 */
export function calculationAssuranceSelectionPaths(
  changedFiles: readonly string[],
  deletedFiles: readonly string[]
): readonly string[] {
  return [...new Set([...changedFiles, ...deletedFiles])];
}

/**
 * Cheap, evidence-free list of the package ids `selectionPaths` select, sorted. Callers that fetch
 * exact-head evidence content over the network (a trusted-base CI job validating isolation) must
 * call this first and fetch evidence only for these packages, so unrelated changes never trigger
 * an evidence API call and a selected package never pays to fetch an unselected one's evidence.
 * Pass `calculationAssuranceSelectionPaths(changedFiles, deletedFiles)`, not changed files alone.
 */
export function selectCalculationAssurancePackageIds(
  selectionPaths: readonly string[],
  rawRegistry: unknown
): readonly string[] {
  const registry = calculationAssuranceRegistrySchema.parse(rawRegistry);
  return registry.packages
    .filter((calculationPackage) => packageIsSelected(calculationPackage, selectionPaths))
    .map((calculationPackage) => calculationPackage.id)
    .sort((left, right) => left.localeCompare(right));
}

/**
 * @param selectionPaths Changed paths unioned with deleted/previous paths, as produced by
 *   `calculationAssuranceSelectionPaths`, so a rename out of a registered selector still selects
 *   the package it moved away from.
 * @param evidenceContent Verified exact-PR-head content for the declared evidence test paths of
 *   the packages `selectionPaths` select, keyed by repo-relative path. Pass this whenever
 *   `repoRoot` is not guaranteed to reflect the PR under review (e.g. a trusted-base CI checkout)
 *   so evidence-isolation is checked against the content that will actually merge rather than a
 *   stale worktree.
 */
export function deriveCalculationAssurancePlan(
  selectionPaths: readonly string[],
  rawRegistry: unknown,
  repoRoot: string = process.cwd(),
  evidenceContent?: ReadonlyMap<string, string>
): CalculationAssurancePlan {
  const registry = calculationAssuranceRegistrySchema.parse(rawRegistry);
  const selected = registry.packages
    .filter((calculationPackage) => packageIsSelected(calculationPackage, selectionPaths))
    .sort((left, right) => left.id.localeCompare(right.id));
  validateRegistry(
    registry.packages,
    repoRoot,
    evidenceContent,
    evidenceContent ? new Set(selected.map((entry) => entry.id)) : null
  );

  if (selected.length === 0) {
    return calculationAssurancePlanSchema.parse({
      schema: 'example.calculation-assurance-plan.v1',
      mode: 'skip',
      selectedPackages: [],
      independentAuditRequired: false,
      targetedTests: [],
      gaps: [],
      reasons: ['no registered financial calculation package changed'],
    });
  }

  const inventoryPackages = selected.filter((entry) => entry.status === 'inventory');
  const enforcedPackages = selected.filter((entry) => entry.status === 'enforced');
  const targetedTests = enforcedPackages
    .flatMap((entry) => [
      ...entry.tests.ruleVectors,
      ...entry.tests.independentOracle,
      ...entry.tests.metamorphicProperties,
      ...entry.tests.mutationSentinels,
    ])
    .sort();
  const gaps = inventoryPackages
    .flatMap((entry) => entry.missingLayers.map((layer) => `${entry.id}:${layer}`))
    .sort();
  const mode =
    registry.rollout === 'enforce' && inventoryPackages.length === 0 ? 'enforce' : 'shadow';

  return calculationAssurancePlanSchema.parse({
    schema: 'example.calculation-assurance-plan.v1',
    mode,
    selectedPackages: selected.map((entry) => entry.id),
    independentAuditRequired: true,
    targetedTests: [...new Set(targetedTests)],
    gaps,
    reasons: selected.map(
      (entry) =>
        `${entry.id} ${entry.status === 'enforced' ? 'has executable assurance evidence' : 'is inventoried but not yet enforceable'}`
    ),
  });
}
