import { spawnSync } from 'node:child_process';
import * as nodeFs from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * The self-hosted runner's completed-job hook (ACTIONS_RUNNER_HOOK_JOB_COMPLETED).
 *
 * After every job it stops the job's leftover processes, empties RUNNER_TEMP,
 * deletes the macOS simulators the run created, and prunes old runner
 * diagnostics. It is installed on each host as a single file next to its
 * launcher (ci/src/actions/installJobCompletedHook.ts), so it imports nothing
 * but Node builtins and runs on the runner's bundled Node.
 *
 * A failure here fails the job that just finished, so only conditions that
 * would otherwise strand the next job on this runner are fatal: a runner
 * environment it cannot trust, a temp entry it cannot remove, or a run-owned
 * simulator it cannot delete. Everything else is logged and left alone.
 *
 * Recursive deletion is delegated to the platform's `rm`, `chmod` and `find`.
 * They traverse physically (fts with fchdir/openat), so a leftover process
 * that renames or swaps a directory mid-walk cannot steer them outside the
 * tree. Node has no openat/unlinkat, so a path-based walk here could not
 * give that guarantee. They are run with argument arrays, never a shell.
 */

const LOG_PREFIX = '[example-runner-cleanup]';
/** Run-owned simulators are named `Example CI <device> <run id>-<run attempt>`. */
const SIMULATOR_PREFIX = 'Example CI ';
const UDID_PATTERN = /^[0-9A-Fa-f]{8}(?:-[0-9A-Fa-f]{4}){3}-[0-9A-Fa-f]{12}$/;

/** A condition that must fail the completed job. */
export class HookFailure extends Error {}

export type FileSystem = Pick<typeof nodeFs,
  'lstatSync' | 'readdirSync' | 'readlinkSync' | 'realpathSync' | 'statSync'>;

export interface CommandResult {
  readonly status: number | null;
  readonly stdout: string;
  readonly stderr?: string;
  readonly error?: NodeJS.ErrnoException;
}

export interface HookSystem {
  readonly fs: FileSystem;
  readonly platform: NodeJS.Platform;
  readonly selfPids: ReadonlySet<number>;
  /** Runs a program from an argument array (no shell), capturing stdout and stderr. */
  readonly run: (program: string, args: readonly string[]) => CommandResult;
  readonly kill: (pid: number, signal: NodeJS.Signals) => void;
  readonly log: (message: string) => void;
}

export interface RunnerPaths {
  readonly runnerRoot: string;
  readonly runnerTemp: string;
}

export interface ProcessEntry {
  readonly pid: number;
  readonly command: string;
}

function errorCode(error: unknown): string | undefined {
  return error instanceof Error && 'code' in error && typeof error.code === 'string' ? error.code : undefined;
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isDirectory(fs: FileSystem, path: string): boolean {
  try {
    return fs.statSync(path).isDirectory();
  } catch (error) {
    if (errorCode(error) === 'ENOENT') return false;
    throw error;
  }
}

/** Validates the runner environment the listener passed to the hook. */
export function resolveRunnerPaths(env: NodeJS.ProcessEnv, fs: FileSystem): RunnerPaths {
  const rootInput = env['EXAMPLE_ACTIONS_RUNNER_ROOT'] ?? '';
  const workdir = env['EXAMPLE_ACTIONS_RUNNER_WORKDIR'] || '_work';
  const tempInput = env['RUNNER_TEMP'] ?? '';
  if (!rootInput.startsWith('/')) throw new HookFailure('EXAMPLE_ACTIONS_RUNNER_ROOT must be an absolute path.');
  if (!/^[A-Za-z0-9._-]+$/.test(workdir)) {
    throw new HookFailure('EXAMPLE_ACTIONS_RUNNER_WORKDIR must be a relative directory name.');
  }
  if (!isDirectory(fs, rootInput)) throw new HookFailure(`runner root does not exist: ${rootInput}`);
  if (tempInput === '' || !isDirectory(fs, tempInput)) {
    throw new HookFailure(`RUNNER_TEMP does not exist: ${tempInput}`);
  }
  const runnerRoot = fs.realpathSync(rootInput);
  const runnerTemp = fs.realpathSync(tempInput);
  const expectedTemp = `${runnerRoot}/${workdir}/_temp`;
  if (runnerTemp !== expectedTemp) {
    throw new HookFailure(`RUNNER_TEMP must equal ${expectedTemp}; got ${runnerTemp}`);
  }
  return { runnerRoot, runnerTemp };
}

function isWithin(path: string, root: string): boolean {
  return path === root || path.startsWith(`${root}/`);
}

/** Parses `ps -axo pid=,command=` output. */
export function parseProcessList(output: string): ProcessEntry[] {
  const entries: ProcessEntry[] = [];
  for (const line of output.split('\n')) {
    const match = /^\s*(\d+)\s*(.*)$/.exec(line);
    if (match?.[1] !== undefined) entries.push({ pid: Number(match[1]), command: match[2] ?? '' });
  }
  return entries;
}

/** Parses `lsof -a -d cwd -Fpn` output into the pids whose cwd is inside `runnerTemp`. */
export function parseLsofCwdPids(output: string, runnerTemp: string): Set<number> {
  const pids = new Set<number>();
  let pid: number | undefined;
  for (const record of output.split('\n')) {
    if (/^p\d+$/.test(record)) pid = Number(record.slice(1));
    else if (record.startsWith('n') && pid !== undefined && isWithin(record.slice(1), runnerTemp)) pids.add(pid);
  }
  return pids;
}

/** Selects the processes a completed job left behind; the runner's own processes are never selected. */
export function completedJobProcesses(options: {
  readonly processes: readonly ProcessEntry[];
  readonly cwdPids: ReadonlySet<number>;
  readonly runnerTemp: string;
  readonly selfPids: ReadonlySet<number>;
}): number[] {
  const { processes, cwdPids, runnerTemp, selfPids } = options;
  return processes
    .filter(({ pid, command }) => !selfPids.has(pid)
      && !command.includes('Runner.Listener') && !command.includes('Runner.Worker')
      && (command.includes(`${runnerTemp}/`) || cwdPids.has(pid)))
    .map(({ pid }) => pid);
}

function procCwdPids(system: HookSystem, runnerTemp: string): Set<number> {
  const pids = new Set<number>();
  for (const name of system.fs.readdirSync('/proc')) {
    if (!/^\d+$/.test(name)) continue;
    try {
      if (isWithin(system.fs.readlinkSync(`/proc/${name}/cwd`), runnerTemp)) pids.add(Number(name));
    } catch {
      // Another user's process hides its cwd, and a process can exit between
      // listing and reading; neither can belong to the completed job's cwd set.
    }
  }
  return pids;
}

function captureCwdPids(system: HookSystem, runnerTemp: string): Set<number> {
  if (isDirectory(system.fs, '/proc')) return procCwdPids(system, runnerTemp);
  const lsof = system.run('lsof', ['-a', '-d', 'cwd', '-Fpn']);
  if (lsof.error !== undefined) {
    if (lsof.error.code !== 'ENOENT') system.log(`could not list process working directories: ${lsof.error.message}`);
    return new Set();
  }
  return parseLsofCwdPids(lsof.stdout, runnerTemp);
}

function listCompletedJobProcesses(system: HookSystem, runnerTemp: string): number[] {
  const ps = system.run('ps', ['-axo', 'pid=,command=']);
  if (ps.error !== undefined || ps.status !== 0) {
    system.log(`could not list processes: ${ps.error?.message ?? `ps exited ${ps.status}`}`);
    return [];
  }
  return completedJobProcesses({
    processes: parseProcessList(ps.stdout),
    cwdPids: captureCwdPids(system, runnerTemp),
    runnerTemp,
    selfPids: system.selfPids,
  });
}

function signal(system: HookSystem, pid: number, name: NodeJS.Signals): void {
  try {
    system.kill(pid, name);
  } catch (error) {
    if (errorCode(error) !== 'ESRCH') system.log(`could not send ${name} to process ${pid}: ${describe(error)}`);
  }
}

/** Stops the completed job's leftover processes: TERM, then KILL for any that remain. */
export function terminateCompletedJobProcesses(system: HookSystem, runnerTemp: string): void {
  const orphans = listCompletedJobProcesses(system, runnerTemp);
  for (const pid of orphans) {
    system.log(`terminating completed-job process ${pid}`);
    signal(system, pid, 'SIGTERM');
  }
  if (orphans.length === 0) return;
  // Orphans of a completed job are not children of this hook, so there is no
  // grace to wait out; anything still present after TERM is killed outright.
  const remaining = new Set(listCompletedJobProcesses(system, runnerTemp));
  for (const pid of orphans) {
    if (!remaining.has(pid)) continue;
    system.log(`force-terminating completed-job process ${pid}`);
    signal(system, pid, 'SIGKILL');
  }
}

function commandDetail(result: CommandResult): string {
  const stderr = result.stderr?.trim() ?? '';
  const status = result.error === undefined ? `exit ${result.status}` : result.error.message;
  return stderr === '' ? status : `${status}: ${stderr}`;
}

function exists(fs: FileSystem, path: string): boolean {
  try {
    fs.lstatSync(path);
    return true;
  } catch (error) {
    if (errorCode(error) === 'ENOENT') return false;
    throw error;
  }
}

/**
 * Removes one RUNNER_TEMP entry with the platform's `rm -rf`, after making a
 * real directory's tree owner-writable (dependency caches such as Go's module
 * cache are read-only). Neither `chmod -R` nor `rm -rf` follows a symlink found while
 * traversing, so a link is removed and its target left alone. (`-P` is not
 * passed: older GNU chmod rejects it, and physical traversal is its default.)
 */
function removeTempEntry(system: HookSystem, entry: string): void {
  if (system.fs.lstatSync(entry).isDirectory()) {
    // BSD chmod treats `--` as a filename. `entry` is rooted under the
    // validated absolute RUNNER_TEMP path, so it cannot be parsed as an option.
    const chmod = system.run('/bin/chmod', ['-R', 'u+rwX', entry]);
    if (chmod.error !== undefined || chmod.status !== 0) {
      system.log(`could not make ${entry} writable before removal (${commandDetail(chmod)})`);
    }
  }
  const rm = system.run('/bin/rm', ['-rf', '--', entry]);
  if (rm.error !== undefined || rm.status !== 0) {
    throw new HookFailure(`failed to remove completed-job temp entry: ${entry} (${commandDetail(rm)})`);
  }
}

/** Empties RUNNER_TEMP. A leftover entry would be inherited by the runner's next job, so it is fatal. */
export function removeTempEntries(system: HookSystem, runnerTemp: string): number {
  const entries = system.fs.readdirSync(runnerTemp).map((name) => join(runnerTemp, name));
  for (const entry of entries) {
    try {
      removeTempEntry(system, entry);
    } catch (error) {
      if (error instanceof HookFailure) throw error;
      if (errorCode(error) !== 'ENOENT') {
        throw new HookFailure(`failed to remove completed-job temp entry: ${entry} (${describe(error)})`);
      }
    }
    if (exists(system.fs, entry)) throw new HookFailure(`completed-job temp entry remains after cleanup: ${entry}`);
  }
  return entries.length;
}

/** Picks the UDIDs of simulators named for this run attempt from `xcrun simctl list devices -j`. */
export function ownedSimulatorUdids(simctlJson: string, runId: string, runAttempt: string): string[] {
  const payload: unknown = JSON.parse(simctlJson);
  const runtimes = typeof payload === 'object' && payload !== null && 'devices' in payload ? payload.devices : {};
  const suffix = ` ${runId}-${runAttempt}`;
  const udids: string[] = [];
  for (const devices of Object.values(typeof runtimes === 'object' && runtimes !== null ? runtimes : {})) {
    if (!Array.isArray(devices)) continue;
    for (const device of devices as unknown[]) {
      if (typeof device !== 'object' || device === null) continue;
      const name = 'name' in device && typeof device.name === 'string' ? device.name : '';
      const udid = 'udid' in device && typeof device.udid === 'string' ? device.udid : '';
      const owned = name.startsWith(SIMULATOR_PREFIX) && name.endsWith(suffix)
        && name.length > SIMULATOR_PREFIX.length + suffix.length;
      if (owned && UDID_PATTERN.test(udid)) udids.push(udid);
    }
  }
  return udids;
}

function xcrun(system: HookSystem, args: readonly string[]): CommandResult {
  const result = system.run('xcrun', args);
  if (result.error?.code === 'ENOENT') throw new HookFailure('xcrun is unavailable for macOS simulator cleanup.');
  if (result.status !== 0) system.log(`xcrun ${args.join(' ')}: ${commandDetail(result)}`);
  return result;
}

/** Deletes the simulators this run attempt created, then every unavailable simulator. */
export function cleanupOwnedMacosSimulators(system: HookSystem, env: NodeJS.ProcessEnv): void {
  if (system.platform !== 'darwin') return;
  const runId = env['GITHUB_RUN_ID'] ?? '';
  const runAttempt = env['GITHUB_RUN_ATTEMPT'] ?? '';
  if (!/^[1-9]\d*$/.test(runId) || !/^[1-9]\d*$/.test(runAttempt)) {
    system.log('skipped simulator cleanup outside a numbered GitHub Actions run');
    return;
  }
  const inventory = xcrun(system, ['simctl', 'list', 'devices', '-j']);
  let udids: string[];
  try {
    if (inventory.error !== undefined || inventory.status !== 0) {
      throw inventory.error ?? new Error(`exit ${inventory.status}`);
    }
    udids = ownedSimulatorUdids(inventory.stdout, runId, runAttempt);
  } catch (error) {
    throw new HookFailure(`could not inventory run-owned macOS simulators (${describe(error)}).`);
  }
  for (const udid of udids) {
    xcrun(system, ['simctl', 'shutdown', udid]);
    if (xcrun(system, ['simctl', 'delete', udid]).status !== 0) {
      throw new HookFailure(`could not delete completed-job simulator ${udid}.`);
    }
    system.log(`deleted completed-job simulator ${udid}`);
  }
  if (xcrun(system, ['simctl', 'delete', 'unavailable']).status !== 0) {
    throw new HookFailure('could not delete unavailable macOS simulators.');
  }
}

export interface DiagnosticResult {
  readonly removedFiles: number;
  readonly removedDirectories: number;
  readonly warnings: readonly string[];
}

const VANISHED = 'No such file or directory';

/**
 * Whether a failed `find` only reported entries that vanished under it. The
 * listener writes and rotates `_diag` while the hook runs, which is exactly
 * the `find: '…/_diag/pages/…log': No such file or directory` noise that used
 * to fail jobs under `set -e`.
 */
export function onlyVanishedEntries(stderr: string): boolean {
  const lines = stderr.split('\n').map((line) => line.trim()).filter((line) => line !== '');
  return lines.length > 0 && lines.every((line) => line.endsWith(VANISHED));
}

function runFind(system: HookSystem, root: string, predicate: readonly string[], warnings: string[]): number {
  const result = system.run('/usr/bin/find', ['-P', root, '-mindepth', '1', ...predicate, '-delete', '-print']);
  const removed = result.stdout.split('\n').filter((line) => line !== '').length;
  if (result.error === undefined && result.status === 0) return removed;
  if (result.error === undefined && onlyVanishedEntries(result.stderr ?? '')) {
    warnings.push(`entries vanished while pruning ${root}; the listener rotated them first`);
  } else {
    warnings.push(`could not prune ${root} (${commandDetail(result)})`);
  }
  return removed;
}

/**
 * Prunes runner diagnostics older than two days (`find -mtime +2`, as the
 * shell hook did), then the directories that leaves empty; `_diag` itself is
 * kept. Errors are reported and never fail the job: the diagnostics are
 * housekeeping, not state a later job inherits.
 */
export function pruneDiagnostics(system: HookSystem, root: string): DiagnosticResult {
  const warnings: string[] = [];
  let rootStats: nodeFs.Stats;
  try {
    rootStats = system.fs.lstatSync(root);
  } catch (error) {
    if (errorCode(error) !== 'ENOENT') warnings.push(`could not inspect ${root}: ${describe(error)}`);
    return { removedFiles: 0, removedDirectories: 0, warnings };
  }
  // A symlinked root would prune its target, which may lie outside the runner.
  if (!rootStats.isDirectory()) {
    warnings.push(`skipped ${root}: not a real directory`);
    return { removedFiles: 0, removedDirectories: 0, warnings };
  }
  const removedFiles = runFind(system, root, ['-type', 'f', '-mtime', '+2'], warnings);
  const removedDirectories = runFind(system, root, ['-type', 'd', '-empty'], warnings);
  return { removedFiles, removedDirectories, warnings };
}

/** Runs every cleanup phase in order; a HookFailure stops the hook. */
export function runJobCompletedHook(env: NodeJS.ProcessEnv, system: HookSystem): void {
  const { runnerRoot, runnerTemp } = resolveRunnerPaths(env, system.fs);
  terminateCompletedJobProcesses(system, runnerTemp);
  const removedEntries = removeTempEntries(system, runnerTemp);
  cleanupOwnedMacosSimulators(system, env);
  const diagnostics = pruneDiagnostics(system, join(runnerRoot, '_diag'));
  for (const warning of diagnostics.warnings) system.log(`diagnostic retention: ${warning}`);
  if (diagnostics.removedFiles > 0 || diagnostics.removedDirectories > 0) {
    system.log(`pruned ${diagnostics.removedFiles} diagnostic files`
      + ` and ${diagnostics.removedDirectories} empty directories`);
  }
  system.log(`removed ${removedEntries} completed-job temp entries from ${runnerTemp}`);
}

/** Runs a program from an argument array, never through a shell. */
export function runCommand(program: string, args: readonly string[]): CommandResult {
  const result = spawnSync(program, args, {
    encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 64 * 1024 * 1024,
  });
  const captured = { status: result.status, stdout: result.stdout ?? '', stderr: result.stderr ?? '' };
  return result.error === undefined ? captured : { ...captured, error: result.error };
}

function main(): void {
  const system: HookSystem = {
    fs: nodeFs,
    platform: process.platform,
    selfPids: new Set([process.pid, process.ppid]),
    run: runCommand,
    kill: (pid, name) => process.kill(pid, name),
    log: (message) => console.log(`${LOG_PREFIX} ${message}`),
  };
  try {
    runJobCompletedHook(process.env, system);
  } catch (error) {
    console.error(`${LOG_PREFIX} Error: ${describe(error)}`);
    process.exitCode = 1;
  }
}

if (process.argv[1] !== undefined && nodeFs.realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) main();
