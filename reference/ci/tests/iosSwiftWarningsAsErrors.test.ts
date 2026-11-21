import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const read = (relativePath: string) => readFileSync(resolve(repoRoot, relativePath), 'utf8');

const CI_SWITCH = 'EXAMPLE_CI_SWIFT_WARNINGS_AS_ERRORS';

test('every CI build-for-testing invocation turns Swift warnings into errors', () => {
  const script = read('scripts/build-ios-ci-test-products.sh');
  const argumentArrays = [...script.matchAll(/\n\s*\w+=\(\n\s*build-for-testing\n([\s\S]*?)\n\s*\)\n/g)];
  assert.equal(argumentArrays.length, 2, 'expected the main and evidence build argument arrays');
  for (const [, body] of argumentArrays) {
    assert.match(body ?? '', new RegExp(`^\\s*${CI_SWITCH}=YES$`, 'm'));
    // Clang deprecation warnings in Apple's StoreKitTest header must not fail the build.
    assert.match(body ?? '', /^\s*"\$sdk_header_deprecation_flags"$/m);
  }
  assert.match(script,
    /^sdk_header_deprecation_flags='OTHER_SWIFT_FLAGS=\$\(inherited\) -Xcc -Wno-deprecated-declarations'$/m);
});

test('the project maps the CI switch onto its own targets without a target override', () => {
  const project = read('ios/example-ios.xcodeproj/project.pbxproj');
  const projectConfigurations = [
    ...project.matchAll(
      /\/\* (?:Debug|Release) configuration for PBXProject "example-ios" \*\/ = \{([\s\S]*?)\n\t\t\};/g,
    ),
  ];
  assert.equal(projectConfigurations.length, 2);
  for (const [, body] of projectConfigurations) {
    assert.match(body ?? '', new RegExp(`SWIFT_TREAT_WARNINGS_AS_ERRORS = "\\$\\(${CI_SWITCH}\\)";`));
  }
  // A target-level value would shadow the project-level mapping.
  const assignments = project.match(/SWIFT_TREAT_WARNINGS_AS_ERRORS = /g) ?? [];
  assert.equal(assignments.length, projectConfigurations.length);
});
