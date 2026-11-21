import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const dir = mkdtempSync(join(tmpdir(), 'fpr-package-'));
try {
  const [pack] = JSON.parse(execFileSync('npm', ['pack', '--ignore-scripts', '--json', '--pack-destination', dir], { encoding: 'utf8' }));
  assert.ok(pack.files.every(({ path }) => /^(bin\/|dist\/|docs\/|README.md$|LICENSE$|package.json$)/u.test(path)));
  assert.ok(!pack.files.some(({ path }) => path.includes('reference') || path.endsWith('.env')));
  execFileSync('npm', ['install', '--prefer-offline', '--ignore-scripts', '--no-audit', '--no-fund', '--prefix', dir, join(dir, pack.filename)], { stdio: 'pipe' });
  const bin = join(dir, 'node_modules/firehosepr/bin/fpr.mjs');
  assert.equal(execFileSync(process.execPath, [bin, '--version'], { encoding: 'utf8' }).trim(), '0.1.0');
  assert.match(execFileSync(process.execPath, [bin, '--help'], { encoding: 'utf8' }), /fpr plan/u);
  execFileSync(process.execPath, ['--input-type=module', '-e',
    "import { balanceTests } from 'firehosepr'; if (balanceTests([{path:'test.ts',seconds:1}],2).length !== 1) throw Error('exports');"], { cwd: dir });
  execFileSync(process.execPath, [bin, 'init'], { cwd: dir });
  assert.throws(() => execFileSync(process.execPath, [bin, 'init'], { cwd: dir, stdio: 'pipe' }));
  assert.throws(() => execFileSync(process.execPath, [bin, 'plan', '--unknown'], { cwd: dir, stdio: 'pipe' }));
  console.log(`Packed install verified: ${pack.files.length} files, ${pack.size} bytes; reference snapshot excluded.`);
} finally { rmSync(dir, { recursive: true, force: true }); }
