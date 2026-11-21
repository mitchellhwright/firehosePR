import { execFileSync } from 'node:child_process';

/**
 * The process inspection the lane steps used to clear a leftover backend and
 * to prove a supervisor owns its own session: `lsof -ti tcp:PORT -sTCP:LISTEN`,
 * `kill -9`, and `ps -o pgid=`. Every tool is spawned with an argument array,
 * so a port or a PID can never be read as shell.
 */

/** PIDs listening on `port`. An `lsof` that finds nothing exits non-zero; that is "none". */
export function listeningPids(port: number): readonly number[] {
  let output: string;
  try {
    output = execFileSync('lsof', ['-ti', `tcp:${port}`, '-sTCP:LISTEN'], { encoding: 'utf8' });
  } catch {
    return [];
  }
  return output
    .split('\n')
    .map((line) => Number.parseInt(line.trim(), 10))
    .filter((pid) => Number.isInteger(pid) && pid > 0);
}

/**
 * The process-group id of `pid`. Node exposes no `getpgrp`, so this asks `ps`,
 * which is the same answer `os.getpgid` gave the shell this replaces.
 */
export function processGroupId(pid: number): number {
  const output = execFileSync('ps', ['-p', String(pid), '-o', 'pgid='], { encoding: 'utf8' });
  const parsed = Number.parseInt(output.trim(), 10);
  if (!Number.isInteger(parsed)) {
    throw new Error(`Could not read the process group of PID ${pid}: ${output.trim()}`);
  }
  return parsed;
}

/** `kill -9 $pids 2>/dev/null || true`: a PID that is already gone is not an error. */
export function forceKill(pids: readonly number[]): void {
  for (const pid of pids) {
    try {
      process.kill(pid, 'SIGKILL');
    } catch {
      // The process exited between the listing and the signal; nothing to stop.
    }
  }
}
