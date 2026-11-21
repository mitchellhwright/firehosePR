import { isProcessTerminating } from './processRunner.ts';
import { runSetupCommand } from './setupDeadline.ts';

export type SimulatorSetupOptions = Parameters<typeof runSetupCommand>[2];
export interface SimulatorSetupIo {
  readonly run: typeof runSetupCommand;
  readonly report: (message: string) => void;
  readonly isCancelled: () => boolean;
}
const defaultIo: SimulatorSetupIo = {
  run: runSetupCommand,
  report: console.log,
  isCancelled: isProcessTerminating,
};
const cancelledStatus = (status: number, io: SimulatorSetupIo): number | undefined =>
  status === 130 || status === 143 ? status : io.isCancelled() ? 143 : undefined;

/** Boots only the selected run-owned simulator, using the existing two-minute budget. */
export async function waitForSimulatorBoot(
  udid: string, options: SimulatorSetupOptions = {}, io: SimulatorSetupIo = defaultIo,
): Promise<number> {
  if (io.isCancelled()) return 143;
  return (await io.run(120, ['xcrun', 'simctl', 'bootstatus', udid, '-b'], options)).status;
}

export async function applySimulatorDefaults(
  udid: string, options: SimulatorSetupOptions = {}, io: SimulatorSetupIo = defaultIo,
): Promise<number> {
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    if (io.isCancelled()) return 143;
    io.report(`Applying AutoFill defaults on ${udid} (attempt ${attempt}/3; write budget 60s).`);
    const write = await io.run(60, ['xcrun', 'simctl', 'spawn', udid,
      'defaults', 'write', '-g', 'AutoFillPasswords', '-bool', 'NO'], options);
    const interrupted = cancelledStatus(write.status, io);
    if (interrupted !== undefined) return interrupted;
    if (write.status === 0) {
      const read = await io.run(15, ['xcrun', 'simctl', 'spawn', udid,
        'defaults', 'read', '-g', 'AutoFillPasswords'], { ...options, capture: true });
      if (read.stderr.length > 0) io.report(read.stderr.trimEnd());
      const interruptedRead = cancelledStatus(read.status, io);
      if (interruptedRead !== undefined) return interruptedRead;
      if (read.status === 0 && read.stdout.replace(/\n+$/, '') === '0') {
        io.report(`Verified AutoFillPasswords=0 on ${udid}.`);
        return 0;
      }
      io.report(`::warning::AutoFill defaults verification failed on ${udid} (attempt ${attempt}/3).`);
    } else {
      io.report(`::warning::AutoFill defaults write failed on ${udid} (attempt ${attempt}/3).`);
    }
  }
  io.report(`::error::Could not apply and verify AutoFill defaults on ${udid} after 3 attempts.`);
  return 1;
}

/** Boot failures get bounded shutdown/erase retries; AutoFill failure is terminal. */
export async function prepareOwnedSimulator(
  udid: string, label: string, options: SimulatorSetupOptions = {}, io: SimulatorSetupIo = defaultIo,
): Promise<number> {
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    if (io.isCancelled()) return 143;
    const boot = await io.run(15, ['xcrun', 'simctl', 'boot', udid], options);
    const interruptedBoot = cancelledStatus(boot.status, io);
    if (interruptedBoot !== undefined) return interruptedBoot;
    const ready = await waitForSimulatorBoot(udid, options, io);
    const interruptedReady = cancelledStatus(ready, io);
    if (interruptedReady !== undefined) return interruptedReady;
    if (ready === 0) return applySimulatorDefaults(udid, options, io);
    io.report(`::warning::${label} lane simulator boot failed on attempt ${attempt}/3.`);
    const shutdown = await io.run(15, ['xcrun', 'simctl', 'shutdown', udid], options);
    const interruptedShutdown = cancelledStatus(shutdown.status, io);
    if (interruptedShutdown !== undefined) return interruptedShutdown;
    if (attempt < 3) {
      let erased = false;
      for (let eraseAttempt = 1; eraseAttempt <= 3; eraseAttempt += 1) {
        if (io.isCancelled()) return 143;
        const erase = await io.run(15, ['xcrun', 'simctl', 'erase', udid], options);
        const interruptedErase = cancelledStatus(erase.status, io);
        if (interruptedErase !== undefined) return interruptedErase;
        if (erase.status === 0) { erased = true; break; }
        io.report(`::warning::${label} lane simulator erase failed on attempt ${eraseAttempt}/3.`);
      }
      if (!erased) io.report(`::warning::${label} lane simulator erase failed before retry.`);
    }
  }
  io.report(`::error::${label} lane simulator failed to boot after 3 attempts.`);
  return 1;
}

export async function verifySimulatorContentSize(
  udid: string, expected: string, label: string,
  options: SimulatorSetupOptions = {}, io: SimulatorSetupIo = defaultIo,
): Promise<number> {
  if (io.isCancelled()) return 143;
  const read = await io.run(15, ['xcrun', 'simctl', 'ui', udid, 'content_size'], { ...options, capture: true });
  if (read.stderr.length > 0) io.report(read.stderr.trimEnd());
  const interrupted = cancelledStatus(read.status, io);
  if (interrupted !== undefined) return interrupted;
  if (read.status !== 0) {
    io.report(`::error::${label} lane content size could not be read.`);
    return 1;
  }
  const actual = read.stdout.replace(/\n+$/, '');
  io.report(`${label} lane content size: ${actual}`);
  if (actual === expected) return 0;
  io.report(`::error::${label} lane expected content size '${expected}' but found '${actual}'.`);
  return 1;
}

export async function setSimulatorContentSize(
  udid: string, expected: string, label: string,
  options: SimulatorSetupOptions = {}, io: SimulatorSetupIo = defaultIo,
): Promise<number> {
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    if (io.isCancelled()) return 143;
    const write = await io.run(15, ['xcrun', 'simctl', 'ui', udid, 'content_size', expected], options);
    const interruptedWrite = cancelledStatus(write.status, io);
    if (interruptedWrite !== undefined) return interruptedWrite;
    if (write.status === 0) {
      const verified = await verifySimulatorContentSize(udid, expected, label, options, io);
      const interruptedRead = cancelledStatus(verified, io);
      if (interruptedRead !== undefined) return interruptedRead;
      if (verified === 0) return 0;
    }
    io.report(`::warning::${label} lane content-size setup failed on attempt ${attempt}/3.`);
  }
  io.report(`::error::${label} lane failed to set content size '${expected}' after 3 attempts.`);
  return 1;
}
