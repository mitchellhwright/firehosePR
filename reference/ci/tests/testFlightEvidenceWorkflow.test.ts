import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { describe, it } from 'node:test';
import { z } from 'zod';

import { workflowJob, type WorkflowJob } from '../src/workflowStepShell.ts';
import { ciEventFieldSource } from '../workflows/lib/ciEvent.ts';

const root = new URL('../../', import.meta.url);
const source = (path: string): string => readFileSync(new URL(path, root), 'utf8');
const iosWorkflow = 'ios-tests.yml';

type Step = NonNullable<WorkflowJob['steps']>[number];
function step(job: WorkflowJob, name: string): Step {
  const found = job.steps?.find((candidate) => candidate.name === name);
  assert.ok(found, `missing workflow step: ${name}`);
  return found;
}

function index(job: WorkflowJob, name: string): number {
  const position = job.steps?.findIndex((candidate) => candidate.name === name) ?? -1;
  assert.ok(position >= 0, `missing workflow step: ${name}`);
  return position;
}

describe('TestFlight signing boundary', () => {
  it('keeps signing secrets and beta publishing out of GitHub Actions', () => {
    const directory = new URL('.github/workflows/', root);
    assert.equal(existsSync(new URL('ios-beta.yml', directory)), false);
    for (const name of readdirSync(directory).filter((file) => /\.ya?ml$/.test(file))) {
      const workflow = source(`.github/workflows/${name}`);
      assert.doesNotMatch(workflow,
        /SIGNING_REPO_DEPLOY_KEY|MATCH_GIT_URL|MATCH_PASSWORD|MATCH_KEYCHAIN_PASSWORD|bundle exec fastlane beta/,
        name);
    }
  });

  it('exports the Match profile installed for each app target', () => {
    const fastfile = source('ios/fastlane/Fastfile');
    const profiles = [
      ['com.examplewealth.exampleapp', 'app_profile_name', 'example-ios'],
      ['com.examplewealth.exampleapp.Example-Credit-Card-Picker', 'card_picker_profile_name',
        'Example Credit Card PickerExtension'],
    ] as const;
    for (const [bundle, variable, target] of profiles) {
      assert.ok(fastfile.includes(`${variable} = ENV.fetch("sigh_${bundle}_appstore_profile-name")`));
      assert.ok(fastfile.includes(`"${bundle}" => ${variable}`));
      assert.match(fastfile, new RegExp(
        `update_code_signing_settings\\([\\s\\S]*?targets: \\["${target}"\\][\\s\\S]*?profile_name: ${variable}`,
      ));
    }
    assert.match(fastfile, /export_options: \{\s*method: "app-store-connect",/);
    assert.doesNotMatch(fastfile, /automatic_code_signing\(|export_method: "app-store"/);
  });
});

describe('unsigned Release archive boundary', () => {
  it('keeps Xcode project phases parseable and the retired extension unembedded', () => {
    const project = source('ios/example-ios.xcodeproj/project.pbxproj');
    assert.doesNotMatch(project, /\bshellScript = \(/);
    assert.match(project, /shellScript = "# Bundle server docs for local RAG\\n/);
    for (const script of ['bundle_server_docs.sh', 'bundle_test_source_snapshot.sh']) {
      assert.ok(project.includes(`scripts/${script}`));
    }
    assert.doesNotMatch(project,
      /E30C5E802EE3965F0016C436 \/\* Embed Foundation Extensions \*\/ =|Example Credit Card PickerExtension\.appex in Embed Foundation Extensions/);
  });

  it('requires exact-head archive success in the aggregate and publishes failure diagnostics', () => {
    const archive = workflowJob(iosWorkflow, 'verify-ios-release-archive');
    const aggregate = workflowJob(iosWorkflow, 'test-ios');
    const producer = workflowJob(iosWorkflow, 'build-ios-native-test-products');
    assert.match(String(archive.if), /native_release_archive_required == 'true'/);
    assert.ok(index(archive, 'Prepare Release archive build cache')
      < index(archive, 'Compile unsigned Release archive'));
    const compile = step(archive, 'Compile unsigned Release archive');
    assert.equal(compile.run, 'bash ../scripts/verify-ios-release-archive.sh');
    assert.equal(compile.env?.EXPECTED_HEAD_SHA,
      `\${{ ${ciEventFieldSource('headSha')} }}`);
    assert.equal(step(archive, 'Upload Release archive diagnostics').with?.path,
      '${{ env.IOS_RELEASE_ARCHIVE_XCODEBUILD_LOG }}');
    assert.ok(!producer.steps?.some((candidate) =>
      candidate.name === 'Compile unsigned Release archive'));
    assert.ok(Array.isArray(aggregate.needs) && aggregate.needs.includes('verify-ios-release-archive'));
    const verdict = step(aggregate, 'Verify iOS test lanes');
    assert.equal(verdict.env?.RELEASE_ARCHIVE_REQUIRED,
      '${{ needs.ios-change-gate.outputs.native_release_archive_required }}');
    assert.equal(verdict.env?.RELEASE_ARCHIVE_RESULT,
      '${{ needs.verify-ios-release-archive.result }}');
  });

  it('builds an unsigned Release app and refuses an archive containing the retired extension', () => {
    for (const script of ['scripts/verify-ios-release-archive.sh',
      'scripts/verify-card-rewards-release-archive.sh']) {
      const verifier = source(script);
      for (const required of ['xcodebuild archive', '-configuration Release',
        '-destination "generic/platform=iOS"', 'CODE_SIGNING_ALLOWED=NO',
        'CODE_SIGNING_REQUIRED=NO']) {
        assert.ok(verifier.includes(required), `${script}: ${required}`);
      }
    }
    const verifier = source('scripts/verify-ios-release-archive.sh');
    for (const required of ['EXPECTED_HEAD_SHA', 'IOS_CI_DERIVED_DATA',
      'IOS_CI_SOURCE_PACKAGES', 'IOS_CI_PACKAGE_CACHE', 'trap cleanup_archive EXIT',
      'run-with-ios-cache-recovery.sh']) {
      assert.ok(verifier.includes(required), required);
    }
    const debtCardVerifier = source('scripts/verify-card-rewards-release-archive.sh');
    assert.ok(debtCardVerifier.includes('Example Credit Card PickerExtension.appex'));
    assert.ok(debtCardVerifier.includes('"retiredExtensionPresent": False'));
  });

  it('excludes retired dependencies from the current iOS and Node graphs', () => {
    const project = source('ios/example-ios.xcodeproj/project.pbxproj');
    const baseTest = source('ios/example-iosUITests/BaseUITestCase.swift');
    assert.doesNotMatch(project, /Fakery|RandomPasswordGenerator|mailslurp-client-swift|productName = mailslurp/);
    assert.doesNotMatch(baseTest, /import (Fakery|mailslurp|PromiseKit)/);
    const lock = z.object({ packages: z.record(z.string(), z.unknown()) })
      .parse(JSON.parse(source('package-lock.json')));
    assert.ok(!Object.keys(lock.packages).some((name) => name.startsWith('node_modules/@supabase/')));
  });
});

describe('exact-head debt-card XCTest product reuse', () => {
  it('ties one immutable cache key to the head and uses it for restore and save', () => {
    const job = workflowJob(iosWorkflow, 'onboarding-e2e');
    const key = step(job, 'Compute exact-head debt-card build key');
    const restore = step(job, 'Restore exact-head debt-card test products');
    const validate = step(job, 'Validate exact-head debt-card test products');
    const build = step(job, 'Build exact-head debt-card test products');
    const save = step(job, 'Save exact-head debt-card test products');
    assert.equal(key.env?.EXACT_HEAD_SHA, '${{ env.ONBOARDING_E2E_COMMIT_SHA }}');
    assert.equal(key.run, 'node ci/src/actions/ios/computeDebtCardBuildKey.ts');
    assert.equal(restore.with?.key, '${{ steps.debt-card-build-key.outputs.cache_key }}');
    assert.equal(save.with?.key, restore.with?.key);
    assert.equal(save.with?.path, restore.with?.path);
    assert.equal(restore.with?.['restore-keys'], undefined);
    assert.equal(validate.run, 'node ci/src/actions/ios/validateDebtCardTestProducts.ts');
    assert.equal(build.run, 'node ci/src/actions/ios/buildDebtCardTestProducts.ts');
    assert.equal(validate.env?.EXACT_HEAD_SHA, key.env?.EXACT_HEAD_SHA);
    assert.equal(build.env?.EXACT_HEAD_SHA, key.env?.EXACT_HEAD_SHA);
    assert.equal(validate.env?.BUILD_FINGERPRINT,
      '${{ steps.debt-card-build-key.outputs.build_fingerprint }}');
    assert.equal(build.env?.BUILD_FINGERPRINT, validate.env?.BUILD_FINGERPRINT);
    assert.equal(build.env?.TEST_PRODUCTS_PATH, validate.env?.TEST_PRODUCTS_PATH);
    assert.ok(index(job, 'Compute exact-head debt-card build key')
      < index(job, 'Restore exact-head debt-card test products'));
    assert.ok(index(job, 'Validate exact-head debt-card test products')
      < index(job, 'Build exact-head debt-card test products'));
    assert.ok(index(job, 'Build exact-head debt-card test products')
      < index(job, 'Save exact-head debt-card test products'));
  });

  it('launches the cached products without rebuilding and only removes the guarded workspace cache', () => {
    const job = workflowJob(iosWorkflow, 'onboarding-e2e');
    const backend = step(job, 'Run Issue 3998 real-backend debt freshness evidence');
    const cleanup = step(job, 'Remove local debt-card test products');
    assert.equal(backend.env?.TEST_PRODUCTS, '${{ env.DEBT_CARD_TEST_PRODUCTS }}');
    assert.equal(backend.env?.SKIP_BUILD, '1');
    for (const forbidden of ['DERIVED_DATA', 'SOURCE_PACKAGES', 'PACKAGE_CACHE']) {
      assert.equal(backend.env?.[forbidden], undefined);
    }
    assert.equal(cleanup.run, 'node ci/src/actions/ios/removeDebtCardTestProducts.ts');
    assert.equal(cleanup.env?.CACHE_DIR,
      '${{ steps.onboarding-paths.outputs.debt_card_cache_dir }}');
    assert.match(String(cleanup.if), /always\(\).*debt-card-evidence/);
  });
});
