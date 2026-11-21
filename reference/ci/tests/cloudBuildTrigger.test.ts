import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

import {
  renderWebDeployIgnoredFiles, webDeployIgnoredFiles, webDeployIgnoredFilesPath,
} from '../cloudbuild/trigger.ts';

function isIgnored(path: string): boolean {
  return webDeployIgnoredFiles.some((pattern) =>
    pattern.endsWith('/**') ? path.startsWith(pattern.slice(0, -2)) : path === pattern);
}

test('CI-only pushes avoid Cloud Build without hiding app or deployment changes', () => {
  for (const path of [
    'ios/example-ios/App.swift',
    '.github/workflows/ios-tests.yml',
    'ci/src/prValidationPlanning.ts',
    'ci/workflows/pr-checks.ts',
    'ci/tests/workflows.model.test.ts',
    'ci/contracts/server-test-runtimes.json',
    'ci/scripts/workflows.ts',
    'ci/package-lock.json',
  ]) assert.equal(isIgnored(path), true, path);

  for (const path of [
    'src/app/page.tsx',
    'server/routes/health.ts',
    'public/logo.svg',
    'ci/cloudbuild/runtime/primaryContainerSmoke.ts',
    'docs/product-guide.md',
    'cloudbuild.yaml',
    'ci/cloudbuild/develop.ts',
    'ci/cloudbuild/runtime/stagingPromotion.ts',
    'terraform/platform/main.tf',
  ]) assert.equal(isIgnored(path), false, path);
});

test('Terraform consumes only the generated typed trigger policy', () => {
  assert.equal(readFileSync(webDeployIgnoredFilesPath, 'utf8'), renderWebDeployIgnoredFiles());
  assert.deepEqual(JSON.parse(readFileSync(webDeployIgnoredFilesPath, 'utf8')), webDeployIgnoredFiles);
  const terraform = readFileSync('terraform/platform/main.tf', 'utf8');
  assert.match(terraform, /ignored_files\s*=\s*jsondecode\(file\("\$\{path\.module\}\/generated-cloud-build-ignored-files\.json"\)\)/);
  assert.doesNotMatch(terraform, /ignored_files\s*=\s*var\./);
});
