import { writeFileSync } from 'node:fs';
import { partitionUiTestFiles } from '../../ios/uiTestPartition.ts';

const usage = 'Usage: partitionUiTests.ts TEST_PLAN SOURCE_ROOT DURATION_HINTS TARGET OUTPUT...';
const [testPlanPath, sourceRoot, durationHintsPath, target, ...outputs] = process.argv.slice(2);
if (testPlanPath === undefined || sourceRoot === undefined || durationHintsPath === undefined
  || target === undefined || outputs.length === 0) {
  throw new Error(usage);
}

const partition = partitionUiTestFiles({
  testPlanPath, sourceRoot, durationHintsPath, target, shardCount: outputs.length,
});
for (const [index, output] of outputs.entries()) {
  writeFileSync(output, `${(partition.shards[index] ?? []).join('\n')}\n`, 'utf8');
}
const durations = partition.estimatedSeconds.map((seconds) => `${seconds.toFixed(1)}s`).join(', ');
const count = partition.selectedCount;
process.stdout.write(
  `Native UI estimated durations: ${durations} across ${count} selected identifiers\n`,
);
