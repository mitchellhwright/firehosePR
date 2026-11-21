import { runStepProgram } from '../../ios/shared/processRunner.ts';
import {
  applySimulatorDefaults, prepareOwnedSimulator, setSimulatorContentSize,
  verifySimulatorContentSize, waitForSimulatorBoot,
} from '../../ios/shared/simulatorPreparation.ts';

await runStepProgram('Simulator preparation', async () => {
  const [operation, udid, ...args] = process.argv.slice(2);
  if (udid === undefined || udid.length === 0) throw new Error('Simulator preparation requires a UDID');
  switch (operation) {
    case 'boot':
      if (args.length === 0) return waitForSimulatorBoot(udid);
      break;
    case 'defaults':
      if (args.length === 0) return applySimulatorDefaults(udid);
      break;
    case 'prepare':
      if (args.length === 1 && args[0] !== undefined) return prepareOwnedSimulator(udid, args[0]);
      break;
    case 'verify-content-size':
      if (args.length === 2 && args[0] !== undefined && args[1] !== undefined) {
        return verifySimulatorContentSize(udid, args[0], args[1]);
      }
      break;
    case 'content-size':
      if (args.length === 2 && args[0] !== undefined && args[1] !== undefined) {
        return setSimulatorContentSize(udid, args[0], args[1]);
      }
      break;
  }
  throw new Error('Invalid simulator preparation operation or argument count');
});
