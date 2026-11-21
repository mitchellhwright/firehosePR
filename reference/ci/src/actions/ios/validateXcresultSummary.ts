import { logLine } from '../../ios/shared/actionIo.ts';
import { runStepProgram } from '../../ios/shared/processRunner.ts';
import { validateXcresultSummary } from '../../ios/xcresultSummary.ts';

await runStepProgram('XCTest result verification', async () => {
  const [bundle, count, label] = process.argv.slice(2);
  if (process.argv.length !== 5 || bundle === undefined || count === undefined || label === undefined) {
    logLine('Usage: validateXcresultSummary.ts <result-bundle> <expected-test-count> <suite-name>');
    return 2;
  }
  return validateXcresultSummary(bundle, count, label);
});
