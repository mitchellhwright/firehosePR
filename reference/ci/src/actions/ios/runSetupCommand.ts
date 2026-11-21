import { runStepProgram } from '../../ios/shared/processRunner.ts';
import { runSetupCommand } from '../../ios/shared/setupDeadline.ts';

await runStepProgram('Simulator setup', async () => {
  const [seconds, ...command] = process.argv.slice(2);
  if (seconds === undefined || !/^\d+$/.test(seconds)) {
    throw new Error('Usage: runSetupCommand.ts <positive-seconds> <command> [arguments...]');
  }
  return (await runSetupCommand(Number(seconds), command)).status;
});
