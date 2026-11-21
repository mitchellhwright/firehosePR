import { createServer } from 'node:net';
import { z } from 'zod';

import {
  allocatedPortMessage,
  isUsablePort,
  laneBackendPortExports,
} from '../../ios/realServerE2eLanes.ts';
import { exportStepEnvBlock, logLine } from '../../ios/shared/actionIo.ts';
import { readStepEnvironment } from '../../ios/shared/stepEnvironment.ts';
import { StepFailure } from '../../ios/shared/stepFailure.ts';
import { runStep } from '../../ios/shared/stepIo.ts';

/**
 * Asks the kernel for a free loopback port and hands it to the lane.
 *
 * Four lanes can share one Mac, so a fixed port would make two lanes fight
 * over the same backend. Binding to port 0 and reading back what the kernel
 * chose is the same trick the Python one-liner used.
 */

const environmentSchema = z.object({
  E2E_LANE: z.string().min(1),
});

async function freeLoopbackPort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const listener = createServer();
    listener.once('error', reject);
    listener.listen(0, '127.0.0.1', () => {
      const address = listener.address();
      if (address === null || typeof address === 'string') {
        listener.close(() => reject(new Error('The kernel did not report a bound port')));
        return;
      }
      const { port } = address;
      listener.close(() => resolve(port));
    });
  });
}

async function run(): Promise<void> {
  const environment = readStepEnvironment(environmentSchema);
  const port = await freeLoopbackPort();
  if (!isUsablePort(port)) {
    throw new StepFailure(`Allocated an unusable backend port: ${port}`, 'stderr');
  }
  exportStepEnvBlock(laneBackendPortExports(port));
  logLine(allocatedPortMessage(port, environment.E2E_LANE));
}

await runStep('Allocate lane-isolated dev backend port', run);
