import { writeFullUiShards, fullUiLanes } from '../../ios/fullUiShards.ts';

const [testPlan, sourceRoot, durationHints, exclusions, ...outputs] = process.argv.slice(2);
if (testPlan === undefined || sourceRoot === undefined || durationHints === undefined
  || exclusions === undefined || (outputs.length !== fullUiLanes.length
    && outputs.length !== fullUiLanes.length - 1)) {
  throw new Error('Usage: partitionFullUiTests.ts TEST_PLAN SOURCE_ROOT DURATION_HINTS EXCLUSIONS [NATIVE1] NATIVE2 NATIVE3 NATIVE4');
}

const plan = writeFullUiShards(testPlan, sourceRoot, durationHints, exclusions, outputs);
const activeLanes = outputs.length === fullUiLanes.length ? fullUiLanes : fullUiLanes.slice(1);
const summary = activeLanes.map((lane) => `${lane}=${plan.estimatedSeconds[lane].toFixed(1)}s`).join(', ');
process.stdout.write(`Native UI estimated durations: ${summary}\n`);
