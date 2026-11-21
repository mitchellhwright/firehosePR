import { prValidationPolicyTests } from '../prValidationPolicyTests.ts';
import { installSignalTraps, runCommand } from '../ios/shared/processRunner.ts';

installSignalTraps(() => {});
const result = await runCommand(process.execPath, ['--test', ...prValidationPolicyTests]);
process.exitCode = result.status;
