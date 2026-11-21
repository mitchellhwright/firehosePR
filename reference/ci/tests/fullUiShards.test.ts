import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';

import {
  discoverUiMethods,
  fullUiLanes,
  planFullUiShards,
  selectedUiTarget,
  storeKitUiMethods,
  writeFullUiShards,
} from '../src/ios/fullUiShards.ts';

const repository = fileURLToPath(new URL('../..', import.meta.url));
const testPlanPath = join(repository, 'ios/example-ios.xcodeproj/xcshareddata/TestPlans/CI.xctestplan');
const sourceRoot = join(repository, 'ios/example-iosUITests');
const durationHintsPath = join(repository, 'ios/ci/ui-test-duration-weights.json');
const exclusionsPath = join(repository, 'ios/ci/ui-test-primary-exclusions.txt');

function selectedSourceMethods(): string[] {
  const target = selectedUiTarget(readFileSync(testPlanPath, 'utf8'));
  const discovered = discoverUiMethods(sourceRoot);
  const normalize = (identifier: string): string => identifier.replace(/\(\)$/, '');
  const skipped = new Set(target.skippedTests.map(normalize));
  const exclusions = new Set(readFileSync(exclusionsPath, 'utf8').split('\n').map(normalize));
  return target.selectedTests.flatMap((selection) => {
    const [className, selectedMethod] = normalize(selection).split('/');
    assert.ok(className);
    const methods = selectedMethod ? [selectedMethod] : discovered[className] ?? [];
    assert.ok(methods.length > 0, `No methods selected for ${className}`);
    return methods.map((method) => `example-iosUITests/${className}/${method}`);
  }).filter((identifier) => {
    const [, className, method] = identifier.split('/');
    assert.ok(className);
    assert.ok(method);
    return !skipped.has(className) && !skipped.has(`${className}/${method}`)
      && !exclusions.has(`example-iosUITests/${className}`) && !exclusions.has(identifier);
  }).sort();
}

describe('full iOS UI partitions', () => {
  it('retains every selected test exactly once and keeps StoreKit methods on native1', () => {
    const temporary = mkdtempSync(join(tmpdir(), 'example-full-ui-shards-'));
    try {
      const outputs = fullUiLanes.map((lane) => join(temporary, `${lane}.txt`));
      const plan = writeFullUiShards(
        testPlanPath,
        sourceRoot,
        durationHintsPath,
        exclusionsPath,
        outputs,
      );
      const identifiers = fullUiLanes.flatMap((lane, index) => {
        const output = outputs[index];
        assert.ok(output);
        const fromFile = readFileSync(output, 'utf8').trim().split('\n');
        assert.deepEqual(fromFile, plan.lanes[lane]);
        return fromFile;
      });
      assert.deepEqual([...identifiers].sort(), selectedSourceMethods());
      assert.equal(identifiers.filter((id) => id.startsWith('example-iosUITests/WorkplacePlanTypeUITests/')).length, 10);
      assert.equal(new Set(identifiers).size, identifiers.length);
      assert.ok(identifiers.includes('example-iosUITests/PersonalPropertyManualEntryUITests/testFinancedVehicleShowsManageLinkAndConfirmsPersonalLoan'));
      for (const identifier of storeKitUiMethods) {
        assert.ok(plan.lanes.native1.includes(identifier));
        assert.ok(!plan.lanes.native2.includes(identifier));
        assert.ok(!plan.lanes.native3.includes(identifier));
        assert.ok(!plan.lanes.native4.includes(identifier));
      }
      assert.ok(plan.estimatedSeconds.native1 < 750);
      for (const lane of ['native2', 'native3', 'native4'] as const) {
        // Ten newly registered methods add 300 seconds of default estimates
        // across the shards. Production timeouts and duration hints are unchanged.
        assert.ok(plan.estimatedSeconds[lane] < 1_100);
      }
    } finally {
      rmSync(temporary, { recursive: true, force: true });
    }
  });

  it('keeps the direct all-mode three-way selection identical to matrix coverage', () => {
    const temporary = mkdtempSync(join(tmpdir(), 'example-combined-ui-shards-'));
    try {
      const paths = ['native2', 'native3', 'native4'].map((lane) => join(temporary, lane));
      const common = [
        testPlanPath,
        sourceRoot,
        durationHintsPath,
        exclusionsPath,
      ] as const;
      const combined = writeFullUiShards(...common, paths);
      const matrix = writeFullUiShards(...common, fullUiLanes.map((lane) => join(temporary, `matrix-${lane}`)));
      const combinedTests = new Set(Object.values(combined.lanes).flat());
      const matrixTests = new Set(Object.values(matrix.lanes).flat());
      assert.deepEqual([...combinedTests].sort(), selectedSourceMethods());
      assert.deepEqual(combinedTests, matrixTests);
    } finally {
      rmSync(temporary, { recursive: true, force: true });
    }
  });

  it('rejects missing StoreKit selection rather than silently dropping a required UI test', () => {
    assert.throws(() => planFullUiShards([
      { identifier: storeKitUiMethods[0], seconds: 10 },
      { identifier: 'example-iosUITests/A/testA', seconds: 10 },
      { identifier: 'example-iosUITests/B/testB', seconds: 10 },
      { identifier: 'example-iosUITests/C/testC', seconds: 10 },
    ]), /Required StoreKit UI method is absent/);
  });
});
