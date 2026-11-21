/** The native selector must account for every executable changed file. */
export interface ChangedFileCoverage {
  readonly path: string;
  readonly owner:
    | 'native' | 'external-e2e' | 'workflow' | 'archive' | 'documentation' | 'test-infrastructure';
  readonly selectedIdentifiers: readonly string[];
  readonly reason?: string;
  /**
   * Set only on a file whose change cannot be proven to a narrow owned test
   * set: a generated Swift model whose declarations could not be traced, or a
   * vendored package linked into the app binary. Such a file widens the plan
   * to the full native suite instead of failing the gate; every other
   * unaccounted file still fails.
   */
  readonly escalation?: FullSuiteEscalation;
}

export type FullSuiteEscalation = 'unprovable-generated-model' | 'linked-native-dependency';

const escalationLabels: Readonly<Record<FullSuiteEscalation, string>> = {
  'unprovable-generated-model': 'generated model change not provable',
  'linked-native-dependency': 'linked native dependency changed',
};

export interface CoverageDecision {
  readonly mode: 'affected' | 'skip' | 'full';
  readonly reason: string;
}

/**
 * A narrow plan is sound only if every native-owned changed file contributes
 * an executable test. External journeys and workflow contracts have their own
 * required owners, so they do not silently widen the native plan. An
 * unprovable generated model and a changed linked dependency are the gaps a
 * superset run closes, so they escalate to the full native suite; any other
 * unaccounted file is a governance failure that running more tests would not
 * catch.
 */
export function decideChangedFileCoverage(
  files: readonly ChangedFileCoverage[],
): CoverageDecision {
  const unaccounted = files.filter((file) =>
    file.owner === 'native' && file.selectedIdentifiers.length === 0);
  const blocking = unaccounted.find((file) => file.escalation === undefined);
  if (blocking !== undefined) {
    throw new Error(`Cannot select iOS tests for ${blocking.path}: ${blocking.reason ?? 'no affected-test rule exists'}`);
  }
  if (unaccounted.length > 0) {
    const groups = Object.entries(escalationLabels).flatMap(([escalation, label]) => {
      const details = unaccounted
        .filter((file) => file.escalation === escalation)
        .map((file) => file.reason ?? `${file.path}: no verified owner`);
      return details.length > 0 ? [`${label}: ${details.join('; ')}`] : [];
    });
    return { mode: 'full', reason: `full: ${groups.join('; ')}` };
  }
  if (files.some((file) => file.owner === 'native')) {
    return { mode: 'affected', reason: 'every native changed file has selected tests' };
  }
  return {
    mode: 'skip',
    reason: files.some((file) => file.owner === 'external-e2e')
      ? 'only separately executed real-server E2E tests changed'
      : 'only workflow and test-infrastructure owner files changed',
  };
}
