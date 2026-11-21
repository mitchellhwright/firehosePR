import { join, relative } from 'node:path';
import {
  formatTypingCoverage,
  measureTypingCoverage,
  typingCoverageRegressions,
} from '../src/typingCoverage.ts';

const root = process.cwd();
const args = new Set(process.argv.slice(2));
const report = measureTypingCoverage(root);

if (args.has('--json')) {
  console.log(JSON.stringify(report, null, 2));
} else if (!args.has('--check')) {
  console.log(formatTypingCoverage(report));
}

if (args.has('--check')) {
  const floorPath = join(root, 'ci/contracts/typing-coverage-floor.json');
  const failures = typingCoverageRegressions(report, floorPath);
  if (failures.length > 0) {
    console.error(
      `typing coverage regressed:\n  ${failures.join('\n  ')}\n` +
        `Raise the floor in ${relative(root, floorPath)} only with the change that earns it.`,
    );
    process.exit(1);
  }
}
