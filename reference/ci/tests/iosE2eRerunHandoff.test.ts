import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { load } from 'js-yaml';

interface WorkflowStep {
  readonly name: string;
  readonly with?: { readonly key?: string };
  readonly env?: Readonly<Record<string, string>>;
  readonly 'continue-on-error'?: boolean;
  readonly 'timeout-minutes'?: number;
  readonly if?: string;
}

const workflow = load(readFileSync(join(process.cwd(), '.github/workflows/ios-tests.yml'), 'utf8')) as {
  readonly jobs: Readonly<Record<string, { readonly steps: readonly WorkflowStep[] }>>;
};

function step(job: string, name: string): WorkflowStep {
  const found = workflow.jobs[job]?.steps.find((candidate) => candidate.name === name);
  assert.ok(found, `${job}: ${name}`);
  return found;
}

test('all E2E lanes restore the producer cache across job-only run attempts', () => {
  const key = 'ios-e2e-test-products-v2-${{ env.ONBOARDING_E2E_COMMIT_SHA }}-${{ github.run_id }}';
  assert.equal(step('build-ios-e2e-test-products', 'Save exact-head E2E products').with?.key, key);
  assert.equal(step('build-ios-e2e-test-products', 'Verify exact-head E2E cache publication').with?.key, key);
  for (const lane of ['onboarding-e2e', 'chat-plaid-e2e', 'income-e2e', 'budget-e2e']) {
    const restore = step(lane, 'Restore exact-head E2E test products');
    assert.equal(restore.with?.key, key, lane);
    assert.equal(restore['continue-on-error'], true, lane);
    assert.equal(restore['timeout-minutes'], 5, lane);
    assert.equal(step(lane, 'Download exact-head E2E products fallback')['continue-on-error'], true);
    assert.equal(
      step(lane, 'Rebuild E2E test products for consumer Xcode').if,
      "steps.prepare-e2e-products.outputs.rebuild_required == 'true'",
    );
  }
});

test('predecessor reuse reads stable keys first and old attempt-scoped caches second', () => {
  const job = 'build-ios-e2e-test-products';
  const stable = step(job, 'Restore content-identical predecessor E2E products');
  const legacy = step(job, 'Restore predecessor E2E products from legacy attempt cache');
  assert.equal(
    stable.with?.key,
    'ios-e2e-test-products-v2-${{ needs.ios-change-gate.outputs.reused_e2e_head_sha }}-${{ needs.ios-change-gate.outputs.reused_e2e_run_id }}',
  );
  assert.equal(legacy.with?.key, stable.with?.key
    + '-${{ needs.ios-change-gate.outputs.reused_e2e_run_attempt }}');
  assert.equal(legacy.if,
    "needs.ios-change-gate.outputs.reuse_e2e_products == 'true' "
      + "&& steps.restore-reused-e2e-test-products.outputs.cache-hit != 'true'");
  const rebind = step(job, 'Bind content-identical E2E products to this exact head');
  assert.match(rebind.if ?? '', /restore-legacy-reused-e2e-test-products\.outputs\.cache-hit == 'true'/);
});

test('transport outage releases a compiled producer only when exact-head consumers can rebuild', () => {
  const job = 'build-ios-e2e-test-products';
  assert.equal(step(job, 'Verify E2E product handoff transport').env?.TRANSPORT_FAILURE_POLICY,
    'consumer-rebuild');
  assert.notEqual(step(job, 'Build exact-head E2E products once')['continue-on-error'], true);
  assert.notEqual(step(job, 'Pack executable E2E products')['continue-on-error'], true);
});
