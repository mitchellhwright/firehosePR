import { readFileSync, writeFileSync } from 'node:fs';
import { serverTestRuntimeManifest } from '../databaseTestInventory.ts';

const path = 'ci/contracts/server-test-runtimes.json';
const generated = `${JSON.stringify(serverTestRuntimeManifest(), null, 2)}\n`;

if (process.argv[2] === '--check') {
  if (readFileSync(path, 'utf8') !== generated) {
    throw new Error(`${path} is stale; run node ci/src/actions/generateServerTestRuntimeManifest.ts`);
  }
} else if (process.argv.length === 2) {
  writeFileSync(path, generated);
} else {
  throw new Error('Usage: node ci/src/actions/generateServerTestRuntimeManifest.ts [--check]');
}
