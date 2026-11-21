import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import {
  findEnabledStateViolations,
  formatEnabledStateViolations,
} from '../src/actions/ios/lintIosUiTestElementState.ts';

describe('iOS UI test enabled-state lint', () => {
  it('rejects direct element reads while permitting snapshot state and comments', async () => {
    const repositoryRoot = mkdtempSync(join(tmpdir(), 'example-ios-enabled-state-'));
    const pageObjects = join(repositoryRoot, 'ios', 'example-iosUITests', 'PageObjects');
    mkdirSync(pageObjects, { recursive: true });
    writeFileSync(join(pageObjects, 'ExamplePage.swift'), [
      '// ignoredElement.isEnabled',
      'let allowed = buttonSnapshot.isEnabled',
      'let alsoAllowed = fieldSnap.isEnabled',
      'let forbidden = continueButton.isEnabled',
    ].join('\n'));
    writeFileSync(join(pageObjects, 'README.md'), 'notAnElement.isEnabled\n');

    try {
      const violations = await findEnabledStateViolations(repositoryRoot);
      assert.deepEqual(violations, [{
        file: 'ios/example-iosUITests/PageObjects/ExamplePage.swift',
        line: 4,
        source: 'let forbidden = continueButton.isEnabled',
      }]);
      assert.match(
        formatEnabledStateViolations(violations),
        /ExamplePage\.swift:4:let forbidden = continueButton\.isEnabled/,
      );
    } finally {
      rmSync(repositoryRoot, { recursive: true, force: true });
    }
  });
});
