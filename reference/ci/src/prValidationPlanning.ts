/** Runtime and authoring contract for the central PR validation planner. */
export const prValidationPlanning = {
  id: 'plan-pr-validation',
  name: 'Plan PR validation',
  retiredNamePattern: '^Docs Change Gate$',
  resultEnvironment: 'PR_VALIDATION_PLAN',
  selection: {
    id: 'plan',
    name: 'Select required validation lanes',
    outputs: [
      'calculation_assurance_gaps', 'calculation_assurance_independent_audit_required',
      'calculation_assurance_mode', 'calculation_assurance_packages', 'database_required',
      'entitlement_acceptance_required', 'docs_only', 'lint_plan', 'ios_contracts_required',
      'metadata_only', 'policy_required', 'server_static_required', 'server_test_mode',
      'process_heavy_required', 'targeted_integration_tests', 'test_only_helpers_to_typecheck',
      'targeted_server_tests', 'workflow_contracts_required', 'plan_json',
    ],
  },
  inventory: {
    id: 'inventory',
    name: 'Collect PR change inventory',
    action: 'collectPrChangeInventory',
    outputs: [
      'metadata_only', 'classifier_inventory_selected', 'file_status_inventory_verified', 'candidate_gone',
    ],
  },
  outputs: [
    'docs_only', 'lint_plan', 'database_required', 'entitlement_acceptance_required', 'metadata_only',
    'policy_required', 'workflow_contracts_required', 'server_static_required',
    'server_test_mode', 'process_heavy_required', 'targeted_server_tests', 'targeted_integration_tests',
    'test_only_helpers_to_typecheck',
    'ios_contracts_required', 'pr_linux_runner_labels', 'pr_database_runner_labels',
    'pr_linux_overflow_labels', 'control_runner_labels', 'trusted_policy_sha',
    'reused_lanes', 'lane_evidence',
  ],
} as const;

export type PrPlanningOutput = typeof prValidationPlanning.outputs[number];
export type PrSelectionOutput = typeof prValidationPlanning.selection.outputs[number];
export const planningResult = `needs.${prValidationPlanning.id}.result`;
export const planningOutput = (name: PrPlanningOutput): string => `needs.${prValidationPlanning.id}.outputs.${name}`;
export const inventoryOutput = (name: typeof prValidationPlanning.inventory.outputs[number]): string =>
  `steps.${prValidationPlanning.inventory.id}.outputs.${name}`;

export const planningNamePattern = new RegExp(
  `^(?:${prValidationPlanning.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}|${prValidationPlanning.retiredNamePattern})$`,
);
