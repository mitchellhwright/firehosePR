import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';

function swiftFiles(directory: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...swiftFiles(path));
    else if (entry.name.endsWith('.swift')) files.push(path);
  }
  return files;
}

test('iOS test code reads runner variables by the name xcodebuild delivers', () => {
  // xcodebuild forwards TEST_RUNNER_<NAME> to test processes as <NAME>, so a
  // prefixed lookup never matches and silently takes its fallback path.
  const offenders: string[] = [];
  for (const target of ['ios/example-iosTests', 'ios/example-iosUITests']) {
    for (const file of swiftFiles(target)) {
      const lines = readFileSync(file, 'utf8').split('\n');
      lines.forEach((line, index) => {
        if (/"TEST_RUNNER_[A-Z0-9_]+"/.test(line)) offenders.push(`${file}:${index + 1}`);
      });
    }
  }
  assert.deepEqual(offenders, []);
});
