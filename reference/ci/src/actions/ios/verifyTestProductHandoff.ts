import { optionalEnv } from '../../ios/shared/actionIo.ts';
import { runStepProgram } from '../../ios/shared/stepDecision.ts';
import { testProductHandoffDecision, type TransportFailurePolicy } from '../../ios/testProductHandoff.ts';

const stepOutcomes = ['', 'success', 'failure', 'cancelled', 'skipped'] as const;
const cacheHits = ['', 'true', 'false'] as const;
const transportFailurePolicies = ['fail', 'consumer-rebuild'] as const satisfies readonly TransportFailurePolicy[];

function readOneOf(name: string, allowed: readonly string[]): string {
  const value = optionalEnv(name);
  if (!allowed.includes(value)) throw new Error(`${name} has an unexpected value: ${value}`);
  return value;
}

function readTransportFailurePolicy(): TransportFailurePolicy {
  const value = optionalEnv('TRANSPORT_FAILURE_POLICY');
  if (value === 'fail' || value === 'consumer-rebuild') return value;
  throw new Error(`TRANSPORT_FAILURE_POLICY has an unexpected value: ${value}; expected ${transportFailurePolicies.join(' or ')}`);
}

/**
 * Applies the producer's explicit transport policy after validating GitHub's
 * string outcomes. Both native and real-server E2E consumers can rebuild
 * from their verified exact head when the transport is unavailable.
 */
runStepProgram('iOS test-product handoff verification', () => {
  return testProductHandoffDecision({
    transportFailurePolicy: readTransportFailurePolicy(),
    cacheSaveOutcome: readOneOf('CACHE_SAVE_OUTCOME', stepOutcomes),
    cacheLookupOutcome: readOneOf('CACHE_LOOKUP_OUTCOME', stepOutcomes),
    cacheHit: readOneOf('CACHE_HIT', cacheHits),
    artifactOutcome: readOneOf('ARTIFACT_OUTCOME', stepOutcomes),
  });
});
