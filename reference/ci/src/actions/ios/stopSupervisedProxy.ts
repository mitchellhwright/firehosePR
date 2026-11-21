import { z } from 'zod';
import { awaitLogLine } from '../../ios/shared/awaitLogLine.ts';

import { isSupervisedProxyName, planProxyStop, supervisedProxies } from '../../ios/supervisedProxyControl.ts';
import { runCommand } from '../../ios/shared/processRunner.ts';
import { renderStepMessage } from '../../ios/shared/stepDecision.ts';
import { readStepEnvironment } from '../../ios/shared/stepEnvironment.ts';
import { StepFailure } from '../../ios/shared/stepFailure.ts';
import { runStep } from '../../ios/shared/stepIo.ts';

/**
 * Stops a proxy the lane started, after proving the recorded PID still belongs
 * to it.
 *
 * One program for both proxies. It reads the command line back with `ps`,
 * lets `ci/src/ios/supervisedProxyControl.ts` decide, signals only what that
 * decision names, and then blocks on the exit record the proxy's own wrapper
 * appends to its log — an event, never a poll.
 */

const environmentSchema = z.object({
  SUPERVISED_PROXY: z.string().min(1, 'SUPERVISED_PROXY is required'),
});

/** `ps -p PID -o command=`: an unknown PID exits non-zero, which is "gone". */
async function commandLineOf(pid: string): Promise<string> {
  const result = await runCommand('ps', ['-p', pid, '-o', 'command='], { capture: true });
  return result.status === 0 ? result.stdout : '';
}

await runStep('Supervised proxy stop', async () => {
  const { SUPERVISED_PROXY: name } = readStepEnvironment(environmentSchema);
  if (!isSupervisedProxyName(name)) throw new Error(`Unknown supervised proxy: ${name}`);

  const spec = supervisedProxies[name];
  const pid = process.env[spec.pidVariable] ?? '';
  if (pid.length === 0) throw new StepFailure(`${spec.pidVariable}: parameter null or not set`, 'stderr');
  const logPath = process.env[spec.logVariable] ?? '';
  if (logPath.length === 0) throw new StepFailure(`${spec.logVariable}: parameter null or not set`, 'stderr');

  const plan = planProxyStop({ spec, pid, commandLine: await commandLineOf(pid) });
  if (plan.kind !== 'terminate') {
    for (const message of plan.messages) process.stdout.write(`${renderStepMessage(message)}\n`);
    if (plan.exitCode !== 0) process.exitCode = plan.exitCode;
    return;
  }

  process.kill(plan.pid, 'SIGTERM');
  await awaitLogLine(logPath, { kind: 'regex', pattern: plan.exitPattern });
  for (const message of plan.messages) process.stdout.write(`${renderStepMessage(message)}\n`);
});
