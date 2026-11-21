import { open, stat } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { StringDecoder } from 'node:string_decoder';

export type LogMatch =
  | { readonly kind: 'literal'; readonly text: string }
  | { readonly kind: 'regex'; readonly pattern: string };

/**
 * Scan complete lines on a bounded interval. Polling is intentional: fs.watch
 * may coalesce or drop events and remains attached to a replaced directory
 * inode, while readiness logs are small and a 250 ms interval is negligible
 * beside process startup. One mechanism handles file creation, truncation,
 * rotation, and directory replacement without retaining a native watcher.
 *
 * fs.watch coalesces modifications and does not expose changed byte ranges.
 * A copy-truncate rewrite may keep the inode and grow beyond the previous EOF
 * before we see an event, even preserving both prefix and suffix. Re-scan the
 * bounded file snapshot on notification instead of trusting a cursor or sampled
 * bytes. These readiness/termination logs are small; correctness takes priority
 * over skipping prefix reads. Coalesce events while a scan is in progress.
 */
export function awaitLogLine(logPath: string, match: LogMatch, signal?: AbortSignal): Promise<string> {
  const regex = match.kind === 'regex' ? new RegExp(match.pattern) : undefined;
  const matches = (line: string): boolean => match.kind === 'literal'
    ? line.includes(match.text) : regex?.test(line) === true;
  const path = resolve(logPath);
  return new Promise<string>((resolveLine, reject) => {
    let settled = false;
    let scanning = false;
    let requested = false;
    let scanTimer: ReturnType<typeof setInterval> | undefined;
    const buffer = Buffer.alloc(64 * 1024);
    const finish = (result: { readonly line: string } | { readonly error: unknown }): void => {
      if (settled) return;
      settled = true;
      if (scanTimer !== undefined) clearInterval(scanTimer);
      signal?.removeEventListener('abort', abort);
      if ('line' in result) resolveLine(result.line);
      else reject(result.error);
    };
    const abort = (): void => finish({ error: signal?.reason ?? new Error('Log wait aborted') });
    const readAvailable = async (): Promise<string | undefined> => {
      const file = await open(path, 'r').catch((error: unknown) => {
        if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return undefined;
        throw error;
      });
      if (!file) return undefined;
      try {
        const stat = await file.stat();
        if (!stat.isFile()) throw new Error(`Log path is not a regular file: ${path}`);
        let offset = 0;
        let pending = '';
        const decoder = new StringDecoder('utf8');
        // Bound this scan to its snapshot. Appends during the read schedule
        // another scan instead of keeping a busy producer in an endless read.
        while (!settled && offset < stat.size) {
          const { bytesRead } = await file.read(buffer, 0, Math.min(buffer.length, stat.size - offset), offset);
          if (bytesRead === 0) break;
          offset += bytesRead;
          pending += decoder.write(buffer.subarray(0, bytesRead));
          let newline = pending.indexOf('\n');
          while (newline !== -1) {
            const line = pending.slice(0, newline);
            pending = pending.slice(newline + 1);
            if (matches(line)) return line;
            newline = pending.indexOf('\n');
          }
        }
        return undefined;
      } finally {
        await file.close();
      }
    };
    const scan = async (): Promise<void> => {
      requested = true;
      if (scanning || settled) return;
      scanning = true;
      try {
        while (requested && !settled) {
          requested = false;
          const line = await readAvailable();
          if (line !== undefined) finish({ line });
        }
      } catch (error: unknown) {
        finish({ error });
      } finally {
        scanning = false;
      }
    };
    if (signal?.aborted) { abort(); return; }
    signal?.addEventListener('abort', abort, { once: true });
    const start = async (): Promise<void> => {
      const parent = await stat(dirname(path));
      if (!parent.isDirectory()) throw new Error(`Log parent is not a directory: ${dirname(path)}`);
      if (settled) return;
      scanTimer = setInterval(() => void scan(), 250);
      void scan();
    };
    void start().catch((error: unknown) => finish({ error }));
  });
}
