import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { countAffectedUiTests } from '../../ios/affectedUiTestCount.ts';
import { discoverUiMethods, selectedUiTargets } from '../../ios/fullUiShards.ts';

const repositoryRoot = fileURLToPath(new URL('../../../../', import.meta.url));
const argumentsToCount = process.argv.slice(2);
const targets = selectedUiTargets(readFileSync(
  `${repositoryRoot}ios/example-ios.xcodeproj/xcshareddata/TestPlans/CI.xctestplan`, 'utf8',
));
const onlyTesting: string[] = [];
const skipped: string[] = [];
for (const argument of argumentsToCount) {
  if (argument.startsWith('-only-testing:')) {
    onlyTesting.push(argument.slice('-only-testing:'.length));
  } else if (argument.startsWith('-skip-testing:')) {
    const identifier = argument.slice('-skip-testing:'.length);
    if (targets[identifier.split('/', 1)[0] ?? ''] !== undefined) skipped.push(identifier);
  } else {
    throw new Error(`Unknown affected UI test argument: ${argument}`);
  }
}

const discovered = discoverUiMethods(`${repositoryRoot}ios/example-iosUITests`);
process.stdout.write(`${countAffectedUiTests(onlyTesting, skipped, targets, discovered)}\n`);
