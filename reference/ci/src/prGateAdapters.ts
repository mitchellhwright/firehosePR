import { calculationAssurancePlanSchema } from './calculationAssurancePlan.ts';

export type DeletionInventory =
  | { readonly source: 'metadata'; readonly contents: '' }
  | { readonly source: 'classifier'; readonly contents: string }
  | { readonly source: 'pull-request'; readonly path: string };

/** Deletions must belong to the inventory actually selected, never a rejected delta. */
export function selectDeletionInventory(input: {
  readonly metadataOnly: boolean;
  readonly classifierSelected: boolean;
  readonly incrementalDeletedFiles: string;
  readonly inventoryVerified: boolean;
  readonly inventoryPath: string;
}): DeletionInventory {
  if (input.metadataOnly) return { source: 'metadata', contents: '' };
  if (input.classifierSelected) {
    return { source: 'classifier', contents: `${input.incrementalDeletedFiles}\n` };
  }
  if (input.inventoryVerified) return { source: 'pull-request', path: input.inventoryPath };
  throw new Error('Changed-file status inventory was not verified.');
}

const assuranceSummarySchema = calculationAssurancePlanSchema.pick({
  mode: true, selectedPackages: true, gaps: true, independentAuditRequired: true,
});

/** Keep the human summary on the same runtime contract as the typed planner. */
export function renderAssuranceSummary(value: unknown): string {
  const plan = assuranceSummarySchema.parse(value);
  return [
    '## Financial calculation assurance', '',
    `Mode: **${plan.mode}**`,
    `Independent exact-head audit: **${plan.independentAuditRequired ? 'required' : 'not selected'}**`, '',
    plan.selectedPackages.length > 0
      ? `Affected packages: ${plan.selectedPackages.map((id) => `\`${id}\``).join(', ')}`
      : 'Affected packages: none',
    plan.gaps.length > 0
      ? `Missing assurance layers: ${plan.gaps.map((gap) => `\`${gap}\``).join(', ')}`
      : 'Missing assurance layers: none', '',
    'Shadow mode reports correlated-verification risk without blocking or rerunning unrelated test lanes.',
  ].join('\n');
}
