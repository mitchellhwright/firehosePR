import { fileURLToPath } from 'node:url';
import { error, fail, info, pass, runStepProgram, type StepDecision } from '../ios/shared/stepDecision.ts';

export function validateMaintenanceDispatchRef(ref: string | undefined): StepDecision {
  if (ref === 'refs/heads/develop' || ref === 'refs/heads/main') {
    return pass(info(`Runner maintenance dispatch accepted from ${ref}.`));
  }
  return fail(error('Runner maintenance requires a trusted develop or main ref.'));
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  runStepProgram('Runner maintenance dispatch ref', () =>
    validateMaintenanceDispatchRef(process.env['DISPATCH_REF']));
}
