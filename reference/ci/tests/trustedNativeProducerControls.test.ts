import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

import { productIosDirectory } from '../src/actions/ios/measureCompiledTestEnumeration.ts';
import { workflowJob } from '../src/workflowStepShell.ts';
import { ciEventFieldSource } from '../workflows/lib/ciEvent.ts';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

test('native producer runs trusted controls against the exact product head', () => {
  const job = workflowJob('ios-tests.yml', 'build-ios-native-test-products');
  const steps = job.steps ?? [];
  const named = (name: string) => {
    const index = steps.findIndex((step) => step.name === name);
    assert.notEqual(index, -1, `missing ${name}`);
    return { index, step: steps[index]! };
  };
  const head = named('Checkout exact native test revision');
  const guard = named('Verify exact native test revision');
  const trusted = named('Checkout trusted native selection controls');
  const selector = named('Determine native build selection');
  const build = named('Build native iOS test products once');
  const enumeration = named('Measure unfiltered compiled iOS tests');
  const preflight = named('Run native unit preflight');

  assert.ok(head.index < trusted.index && trusted.index < guard.index);
  assert.ok(guard.index < selector.index);
  assert.equal(guard.step.run,
    'node ../.ci/trusted-native-controls/ci/src/actions/ios/verifyExactIosRevision.ts');
  assert.ok(selector.index < build.index && build.index < enumeration.index
    && enumeration.index < preflight.index);
  assert.equal(head.step.with?.ref, `\${{ ${ciEventFieldSource('headSha')} }}`);
  assert.equal(head.step.with?.path, undefined);
  assert.equal(trusted.step.with?.ref,
    '${{ needs.ios-change-gate.outputs.verifier_sha || env.EXAMPLE_CI_TRUSTED_BASE_SHA }}');
  assert.equal(trusted.step.with?.path, '.ci/trusted-native-controls');
  assert.equal(trusted.step.with?.['persist-credentials'], false);
  assert.match(String(trusted.step.with?.['sparse-checkout']), /^ci\nscripts\n$/);
  assert.equal(selector.step.run,
    'node ../.ci/trusted-native-controls/scripts/select-ios-affected-tests.ts');
  assert.equal(selector.step.env?.IOS_AFFECTED_TESTS_WORKSPACE, '${{ github.workspace }}');
  assert.equal(build.step.run, 'bash ../scripts/build-ios-ci-test-products.sh');
  assert.equal(enumeration.step.run,
    'node ../.ci/trusted-native-controls/ci/src/actions/ios/measureCompiledTestEnumeration.ts');
  assert.equal(enumeration.step.env?.IOS_PRODUCT_WORKSPACE, '${{ github.workspace }}');
  assert.equal(preflight.step.run, 'node ../ci/src/actions/ios/runNativeUnitPreflight.ts');
});

test('native gate, producer, and consumer select tests with the same verifier revision', () => {
  const gate = workflowJob('ios-tests.yml', 'ios-change-gate');
  const producer = workflowJob('ios-tests.yml', 'build-ios-native-test-products');
  const consumer = workflowJob('ios-tests.yml', 'test-ios-execution');
  const getStep = (steps: typeof producer.steps, name: string) => {
    const step = steps?.find((candidate) => candidate.name === name);
    assert.ok(step, `missing ${name}`);
    return step;
  };
  const producerCheckout = getStep(producer.steps, 'Checkout trusted native selection controls');
  const consumerCheckout = getStep(consumer.steps, 'Checkout trusted native selection controls');
  const gateCheckout = getStep(gate.steps, 'Checkout trusted native selection controls');
  assert.equal(consumerCheckout.with?.ref, producerCheckout.with?.ref);
  assert.equal(gateCheckout.with?.ref,
    '${{ steps.precheck.outputs.verifier_sha || env.EXAMPLE_CI_TRUSTED_BASE_SHA }}');
  assert.equal(consumerCheckout.with?.path, producerCheckout.with?.path);
  assert.equal(gateCheckout.with?.path, producerCheckout.with?.path);
  assert.equal(consumerCheckout.with?.['persist-credentials'], false);
  assert.equal(gateCheckout.with?.['persist-credentials'], false);
  const producerSelector = getStep(producer.steps, 'Determine native build selection');
  const consumerSelector = getStep(consumer.steps, 'Determine Affected iOS Tests');
  const gateSelector = getStep(gate.steps, 'Select native iOS tests');
  assert.equal(consumerSelector.run, producerSelector.run);
  assert.equal(gateSelector.run,
    'node .ci/trusted-native-controls/scripts/select-ios-affected-tests.ts');
  assert.equal(gateSelector.env?.IOS_AFFECTED_TESTS_WORKSPACE, '${{ github.workspace }}');
  assert.equal(consumerSelector.env?.IOS_AFFECTED_TESTS_WORKSPACE, '${{ github.workspace }}');
});

test('selector in a separate trusted checkout reads the head workspace', () => {
  const temporary = mkdtempSync(join(tmpdir(), 'example-trusted-selector-'));
  try {
    const trusted = join(temporary, 'trusted');
    const scripts = join(trusted, 'scripts');
    mkdirSync(scripts, { recursive: true });
    copyFileSync(join(repoRoot, 'scripts/select-ios-affected-tests.ts'),
      join(scripts, 'select-ios-affected-tests.ts'));
    copyFileSync(join(repoRoot, 'scripts/swift-test-impact.ts'),
      join(scripts, 'swift-test-impact.ts'));
    symlinkSync(join(repoRoot, 'ci'), join(trusted, 'ci'), 'dir');
    const output = join(temporary, 'output');
    const result = spawnSync(process.execPath, [join(scripts, 'select-ios-affected-tests.ts')], {
      cwd: temporary,
      encoding: 'utf8',
      env: {
        ...process.env,
        GITHUB_OUTPUT: output,
        IOS_AFFECTED_TESTS_WORKSPACE: repoRoot,
        IOS_AFFECTED_TESTS_CHANGED_FILES: 'ios/example-iosTests/CanonicalMortgageChatPayloadTests.swift',
        IOS_AFFECTED_TESTS_LANE: 'main',
        IOS_AFFECTED_TESTS_MODE: 'affected',
        IOS_AFFECTED_TESTS_STOREKIT_REQUIRED: 'false',
      },
    });
    assert.equal(result.status, 0, result.stderr);
    assert.match(readFileSync(output, 'utf8'), /^mode=affected$/m);
    assert.match(readFileSync(output, 'utf8'), /^test_count=[1-9]\d*$/m);
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
});

test('compiled enumeration resolves plans beside the product checkout', () => {
  assert.equal(productIosDirectory('/tmp/product-head', '/tmp/trusted/ios'),
    '/tmp/product-head/ios');
  assert.equal(productIosDirectory('', '/tmp/product-head/ios'), '/tmp/product-head/ios');
  assert.throws(() => productIosDirectory('relative-head', '/tmp/trusted/ios'),
    /IOS_PRODUCT_WORKSPACE must be an absolute path/);
});
