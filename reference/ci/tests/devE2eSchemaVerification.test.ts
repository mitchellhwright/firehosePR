import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  deriveSchemaVerdict,
  manifestRemovalMessage,
  migrationManifestPath,
  requiredSchemaVerifierScripts,
  schemaRevisionVerifierAvailability,
} from '../src/ios/devE2eSchemaVerification.ts';
import { decisionErrors, renderStepMessage } from '../src/ios/shared/stepDecision.ts';

describe('schemaRevisionVerifierAvailability', () => {
  it('is available only when the trusted base carries both scripts', () => {
    assert.equal(schemaRevisionVerifierAvailability([true, true]).available, 'true');
    assert.deepEqual(schemaRevisionVerifierAvailability([true, true]).messages, []);
  });

  it('skips the revision check when either script is absent', () => {
    for (const present of [[true, false], [false, true], [false, false]]) {
      const availability = schemaRevisionVerifierAvailability(present);
      assert.equal(availability.available, 'false', JSON.stringify(present));
      assert.match(availability.messages[0] ?? '', /predates the E2E schema-revision verifier/);
    }
  });

  it('treats a short answer as unavailable rather than as a pass', () => {
    assert.equal(schemaRevisionVerifierAvailability([]).available, 'false');
    assert.equal(schemaRevisionVerifierAvailability([true]).available, 'false');
  });

  it('names both scripts the availability check looks for', () => {
    assert.deepEqual([...requiredSchemaVerifierScripts], [
      'server/scripts/materializeDevE2eSchemaRevision.ts',
      'server/scripts/verifyDevE2eSchemaRevision.ts',
    ]);
  });
});

describe('deriveSchemaVerdict', () => {
  const passing = { revisionRequired: 'true', revisionOutcome: 'success', objectOutcome: 'success' };

  it('passes when both diagnostics succeeded', () => {
    const decision = deriveSchemaVerdict(passing);
    assert.equal(decision.exitCode, 0);
    assert.deepEqual(decision.messages.map(renderStepMessage), [
      '::notice::Development E2E migration revision and schema object verification passed.',
    ]);
  });

  it('fails on an unapplied migration and names the outcome', () => {
    const decision = deriveSchemaVerdict({ ...passing, revisionOutcome: 'failure' });
    assert.equal(decision.exitCode, 1);
    assert.deepEqual(decisionErrors(decision), [
      'Migration revision verification finished with outcome: failure.',
    ]);
  });

  it('fails on object drift', () => {
    const decision = deriveSchemaVerdict({ ...passing, objectOutcome: 'skipped' });
    assert.equal(decision.exitCode, 1);
    assert.deepEqual(decisionErrors(decision), [
      'Schema object verification finished with outcome: skipped.',
    ]);
  });

  it('reports both problems from one attempt, revision first', () => {
    const decision = deriveSchemaVerdict({
      revisionRequired: 'true', revisionOutcome: 'cancelled', objectOutcome: 'failure',
    });
    assert.deepEqual(decisionErrors(decision), [
      'Migration revision verification finished with outcome: cancelled.',
      'Schema object verification finished with outcome: failure.',
    ]);
  });

  it('waives only the revision half when the verifier was unavailable', () => {
    const decision = deriveSchemaVerdict({
      revisionRequired: 'false', revisionOutcome: 'skipped', objectOutcome: 'success',
    });
    assert.equal(decision.exitCode, 0);
  });

  it('still demands the object check when the revision half is waived', () => {
    const decision = deriveSchemaVerdict({
      revisionRequired: 'false', revisionOutcome: 'success', objectOutcome: 'failure',
    });
    assert.equal(decision.exitCode, 1);
    assert.equal(decisionErrors(decision).length, 1);
  });

  it('treats an unrendered availability value as not required, as the shell did', () => {
    const decision = deriveSchemaVerdict({
      revisionRequired: '', revisionOutcome: 'failure', objectOutcome: 'success',
    });
    assert.equal(decision.exitCode, 0);
  });
});

describe('the per-run migration manifest', () => {
  it('derives one path from the runner temp and the run id', () => {
    assert.equal(
      migrationManifestPath('/runner/_temp', '34958669346'),
      '/runner/_temp/example-e2e-required-migrations-34958669346.json',
    );
  });

  it('reports removal and absence without failing either way', () => {
    const removed = manifestRemovalMessage('/tmp/manifest.json', true);
    assert.equal(removed.exitCode, 0);
    assert.match(removed.messages[0]?.text ?? '', /^Removed \/tmp\/manifest\.json\.$/);
    const absent = manifestRemovalMessage('/tmp/manifest.json', false);
    assert.equal(absent.exitCode, 0);
    assert.match(absent.messages[0]?.text ?? '', /^No migration manifest at/);
  });
});
