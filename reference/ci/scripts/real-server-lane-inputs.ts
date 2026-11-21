import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import {
  buildRealServerLaneInputs,
  serializeRealServerLaneInputs,
  unsafeRealServerLaneInputs,
} from '../src/ios/realServerLaneInputs.ts';

const contractPath = 'ci/contracts/real-server-lane-inputs.v1.json';
const files = execFileSync('git', ['ls-files', '-z'], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
  .split('\0')
  .filter((file) => file.length > 0 && existsSync(file));
const contract = buildRealServerLaneInputs({ files, read: (file) => readFileSync(file, 'utf8') });
const generated = serializeRealServerLaneInputs(contract);

if (process.argv.includes('--check')) {
  const committed = existsSync(contractPath) ? readFileSync(contractPath, 'utf8') : '';
  const unsafe = unsafeRealServerLaneInputs(committed, contract, files);
  if (unsafe.length > 0) {
    console.error(
      `${contractPath} withholds lanes that now load ${unsafe.length} path(s):\n  `
        + `${unsafe.slice(0, 40).join('\n  ')}\n`
        + 'Regenerate it with `npm run ci:server-lane-inputs` and commit the result.',
    );
    process.exit(1);
  }
  if (committed !== generated) {
    console.log(`${contractPath} is wider than needed; \`npm run ci:server-lane-inputs\` narrows it.`);
  }
} else {
  writeFileSync(contractPath, generated);
  console.log(`Wrote ${contractPath}.`);
}
