import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { runCommand } from '../src/ios/shared/processRunner.ts';

const library = fileURLToPath(new URL('../../scripts/ios-ci-simulator-preparation.sh', import.meta.url));
const cli = fileURLToPath(new URL('../src/actions/ios/prepareSimulator.ts', import.meta.url));

test('the remaining shell callers execute the typed preparation and content-size owner', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'example-simulator-bootstrap-'));
  const record = join(directory, 'calls.jsonl');
  try {
    writeFileSync(join(directory, 'xcrun'), [
      '#!/usr/bin/env node',
      'const args = process.argv.slice(2);',
      'require("node:fs").appendFileSync(process.env.EXAMPLE_SIMULATOR_RECORD, JSON.stringify(args) + "\\n");',
      'if (args.includes("read")) console.log("0");',
      'if (args[1] === "ui" && args.length === 4) console.log("large");',
    ].join('\n'), { mode: 0o755 });
    const udid = 'owned; $(false)';
    const env = { ...process.env, PATH: `${directory}:${process.env.PATH}`, EXAMPLE_SIMULATOR_RECORD: record };
    const result = await runCommand('bash', ['-c',
      'source "$1"; prepare_simulator "$2" "Main UI" && set_and_verify_content_size "$2" large "Main UI"',
      'simulator-bootstrap', library, udid], { env, capture: true, timeoutMs: 20_000 });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /Verified AutoFillPasswords=0/);
    assert.match(result.stdout, /Main UI lane content size: large/);
    const calls: unknown[] = readFileSync(record, 'utf8').trim().split('\n').map(line => JSON.parse(line) as unknown);
    assert.equal(calls.length, 6);
    assert.ok(calls.every(call => Array.isArray(call) && call[2] === udid));
    rmSync(record);
    for (const args of [[], ['unknown', udid], ['prepare', udid], ['content-size', udid, 'large'], ['boot', udid, 'unexpected']]) {
      const invalid = await runCommand(process.execPath, [cli, ...args], { env, capture: true, timeoutMs: 10_000 });
      assert.equal(invalid.status, 1);
      assert.equal(existsSync(record), false, 'malformed commands must not invoke simctl');
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
