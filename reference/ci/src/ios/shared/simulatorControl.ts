import { spawnSync } from 'node:child_process';
import { z } from 'zod';

import { logLine } from './actionIo.ts';
import { runCommand } from './processRunner.ts';
import { prepareSimulator, runWithTimeout } from './iosShellHelpers.ts';
import type { IosShellHelperPaths } from './iosShellHelpers.ts';
import { simulatorsToRelease, verifySimulatorStopped } from '../executionPlan.ts';

/**
 * Simulator inventory and exclusive activation.
 *
 * The step owns up to three simulators at once but a four-core runner can only
 * keep one alive while XCTest allocates its workers, so every phase activates
 * exactly one and proves the others reached `Shutdown` first. The `jq` filters
 * the shell used are replaced by parsing the same `simctl … --json` payload
 * here; nothing else about the sequence changes.
 */

const deviceSchema = z.object({
  udid: z.string(),
  name: z.string(),
  state: z.string(),
  deviceTypeIdentifier: z.string().optional(),
}).passthrough();

const deviceInventorySchema = z.object({
  devices: z.record(z.string(), z.array(deviceSchema)),
}).passthrough();

export interface SimulatorIdentity {
  readonly deviceName: string;
  readonly deviceModel: string;
  readonly runtime: string;
}

export interface SimulatorRecord extends SimulatorIdentity {
  readonly state: string;
}

/** Every device simctl reports, flattened with its runtime, keyed by UDID. */
export function parseSimulatorInventory(json: string): ReadonlyMap<string, SimulatorRecord> {
  const inventory = deviceInventorySchema.parse(JSON.parse(json));
  const records = new Map<string, SimulatorRecord>();
  for (const [runtime, devices] of Object.entries(inventory.devices)) {
    for (const device of devices) {
      if (records.has(device.udid)) continue;
      records.set(device.udid, {
        deviceName: device.name,
        deviceModel: device.deviceTypeIdentifier ?? '',
        runtime,
        state: device.state,
      });
    }
  }
  return records;
}

export interface SimulatorControl {
  readonly helpers: IosShellHelperPaths;
  readonly ownedUdids: readonly string[];
  readonly cwd: string;
}

/** `xcrun simctl list devices --json`, read once per call under the setup budget. */
async function readInventory(
  control: SimulatorControl,
  timeoutSeconds: number | undefined,
): Promise<ReadonlyMap<string, SimulatorRecord> | undefined> {
  const result = timeoutSeconds === undefined
    ? await runCommand('xcrun', ['simctl', 'list', 'devices', '--json'], {
      cwd: control.cwd,
      capture: true,
    })
    : await runWithTimeout(
      control.helpers,
      timeoutSeconds,
      ['xcrun', 'simctl', 'list', 'devices', '--json'],
      { cwd: control.cwd, capture: true },
    );
  if (result.status !== 0) return undefined;
  try {
    return parseSimulatorInventory(result.stdout);
  } catch {
    return undefined;
  }
}

/** The `{deviceName, deviceModel, runtime}` triple the issue #4549 run reports. */
export async function readSimulatorIdentity(
  control: SimulatorControl,
  udid: string,
): Promise<SimulatorIdentity | undefined> {
  const inventory = await readInventory(control, undefined);
  return inventory?.get(udid);
}

/**
 * Shuts down every owned simulator but `selected`, proves each reached
 * `Shutdown`, then boots and prepares `selected`. Returns the status the
 * shell's `activate_only_simulator` returned.
 */
export async function activateOnlySimulator(
  control: SimulatorControl,
  selected: string,
  label: string,
): Promise<number> {
  for (const owned of simulatorsToRelease(control.ownedUdids, selected)) {
    await runWithTimeout(control.helpers, 15, ['xcrun', 'simctl', 'shutdown', owned], {
      cwd: control.cwd,
      capture: true,
    });
    const inventory = await readInventory(control, 15);
    const verdict = verifySimulatorStopped(owned, inventory?.get(owned)?.state, label);
    if (verdict.kind !== 'ready') {
      logLine(verdict.message);
      return 1;
    }
  }
  return prepareSimulator(control.helpers, selected, label, { cwd: control.cwd });
}

/** Returns the lane's simulators to the default content size on the way out. */
export async function restoreContentSize(
  control: SimulatorControl,
  udids: readonly string[],
): Promise<void> {
  for (const udid of udids) {
    await runCommand('xcrun', ['simctl', 'ui', udid, 'content_size', 'large'], {
      cwd: control.cwd,
      capture: true,
    });
  }
}

/**
 * The same restore from a signal handler, where nothing awaits a promise. The
 * shell's EXIT trap ran after `exit 130`/`exit 143` for the same reason: a
 * cancelled lane must not leave a shared runner's simulator at an
 * accessibility content size for the next job.
 */
export function restoreContentSizeSync(control: SimulatorControl, udids: readonly string[]): void {
  for (const udid of udids) {
    spawnSync('xcrun', ['simctl', 'ui', udid, 'content_size', 'large'], {
      cwd: control.cwd,
      stdio: 'ignore',
    });
  }
}
