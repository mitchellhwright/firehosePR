import assert from 'node:assert/strict';
import test from 'node:test';

import { ExpressionValue } from 'gagen';

import { buildIosE2eTestProducts } from '../workflows/ios-tests/build-ios-e2e-test-products.ts';
import { buildIosNativeTestProducts } from '../workflows/ios-tests/build-ios-native-test-products.ts';
import { testIosExecution } from '../workflows/ios-tests/test-ios-execution.ts';

test('native and E2E product consumers may rebuild at exact head when both handoffs fail', () => {
  const handoffPolicy = (steps: typeof buildIosNativeTestProducts.config.steps, name: string) => {
    const step = steps.find((candidate) => candidate.config.name === name);
    assert.ok(step);
    return step.config.env?.TRANSPORT_FAILURE_POLICY;
  };
  assert.equal(
    handoffPolicy(buildIosNativeTestProducts.config.steps, 'Verify native product handoff transport'),
    'consumer-rebuild',
  );
  assert.equal(
    handoffPolicy(buildIosE2eTestProducts.config.steps, 'Verify E2E product handoff transport'),
    'consumer-rebuild',
  );
});

test('native producer uploads a fallback artifact only when the verified cache is unavailable', () => {
  const fallbackCondition = (steps: typeof buildIosNativeTestProducts.config.steps, name: string) => {
    const step = steps.find((candidate) => candidate.config.name === name);
    assert.ok(step);
    assert.ok(step.config.if instanceof ExpressionValue);
    return step.config.if.expression;
  };

  assert.equal(
    fallbackCondition(buildIosNativeTestProducts.config.steps, 'Upload exact-head native products fallback'),
    "needs.ios-change-gate.outputs.native_handoff_required == 'true' "
      + "&& (steps.verify-native-test-products-cache.outcome != 'success' "
      + "|| steps.verify-native-test-products-cache.outputs.cache-hit != 'true')",
  );
});

test('native producer installs typed dependencies after revision admission and before unit preflight', () => {
  const steps = buildIosNativeTestProducts.config.steps;
  const position = (name: string) => steps.findIndex((step) => step.config.name === name);
  const guardIndex = position('Verify exact native test revision');
  const installIndex = position('Install typed native producer dependencies');
  const preflightIndex = position('Run native unit preflight');
  assert.ok(guardIndex >= 0);
  assert.ok(installIndex > guardIndex);
  assert.ok(preflightIndex > installIndex);
  assert.equal(steps[installIndex]?.config.command,
    'npm ci --prefix ../ci --no-audit --no-fund --ignore-scripts');
});

test('native product restore retries only after a miss, then accepts either cache hit', () => {
  const steps = testIosExecution.config.steps;
  const named = (name: string) => {
    const index = steps.findIndex((step) => step.config.name === name);
    assert.notEqual(index, -1, name);
    const step = steps[index];
    assert.ok(step);
    return { index, config: step.config };
  };
  const condition = (value: unknown): string => {
    assert.ok(value instanceof ExpressionValue);
    return value.expression;
  };

  const first = named('Restore exact-head native test products');
  const retry = named('Retry exact-head native test products restore once');
  const fallback = named('Download exact-head native products fallback');
  const prepare = named('Prepare native test products and result paths');
  const rebuild = named('Rebuild native test products for consumer Xcode');

  assert.equal(retry.index, first.index + 1);
  assert.equal(fallback.index, retry.index + 1);
  assert.equal(prepare.index, fallback.index + 1);
  assert.ok(rebuild.index > prepare.index);
  assert.equal(first.config.continueOnError, true);
  assert.equal(retry.config.continueOnError, true);
  assert.equal(first.config.timeoutMinutes, 5);
  assert.equal(retry.config.timeoutMinutes, 5);
  assert.deepEqual(retry.config.with, first.config.with);
  assert.equal(retry.config.uses, first.config.uses);
  assert.equal(
    condition(retry.config.if),
    "steps.affected-tests.outputs.should_run == 'true' "
      + "&& (steps.restore-native-test-products.outcome != 'success' "
      + "|| steps.restore-native-test-products.outputs.cache-hit != 'true')",
  );
  assert.equal(
    condition(fallback.config.if),
    "steps.affected-tests.outputs.should_run == 'true' "
      + "&& (steps.restore-native-test-products.outcome != 'success' "
      + "|| steps.restore-native-test-products.outputs.cache-hit != 'true') "
      + "&& (steps.retry-restore-native-test-products.outcome != 'success' "
      + "|| steps.retry-restore-native-test-products.outputs.cache-hit != 'true')",
  );
  assert.equal(
    condition(prepare.config.if),
    "steps.affected-tests.outputs.should_run == 'true'",
  );
  assert.equal(
    condition(rebuild.config.if),
    "steps.affected-tests.outputs.should_run == 'true' "
      + "&& steps.prepare-native-products.outputs.rebuild_required == 'true'",
  );
});
