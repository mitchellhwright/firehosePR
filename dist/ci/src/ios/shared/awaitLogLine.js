import { open, stat } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { StringDecoder } from 'node:string_decoder';
/**
 * Scan complete lines on a bounded interval. Polling is intentional: fs.watch
 * may coalesce or drop events and remains attached to a replaced directory
 * inode, while readiness logs are small and a 250 ms interval is negligible
 * beside process startup. One mechanism handles file creation, truncation,
 * rotation, and directory replacement without retaining a native watcher.
 *
 */
export function awaitLogLine(logPath, match, signal) {
    const regex = match.kind === 'regex' ? new RegExp(match.pattern) : undefined;
    const matches = (line) => match.kind === 'literal'
        ? line.includes(match.text) : regex?.test(line) === true;
    const path = resolve(logPath);
    return new Promise((resolveLine, reject) => {
        let settled = false;
        let scanning = false;
        let requested = false;
        let scanTimer;
        const buffer = Buffer.alloc(64 * 1024);
        const finish = (result) => {
            if (settled)
                return;
            settled = true;
            if (scanTimer !== undefined)
                clearInterval(scanTimer);
            signal?.removeEventListener('abort', abort);
            if ('line' in result)
                resolveLine(result.line);
            else
                reject(result.error);
        };
        const abort = () => finish({ error: signal?.reason ?? new Error('Log wait aborted') });
        const readAvailable = async () => {
            const file = await open(path, 'r').catch((error) => {
                if (error instanceof Error && 'code' in error && error.code === 'ENOENT')
                    return undefined;
                throw error;
            });
            if (!file)
                return undefined;
            try {
                const stat = await file.stat();
                if (!stat.isFile())
                    throw new Error(`Log path is not a regular file: ${path}`);
                let offset = 0;
                let pending = '';
                const decoder = new StringDecoder('utf8');
                // Bound this scan to its snapshot. Appends during the read schedule
                // another scan instead of keeping a busy producer in an endless read.
                while (!settled && offset < stat.size) {
                    const { bytesRead } = await file.read(buffer, 0, Math.min(buffer.length, stat.size - offset), offset);
                    if (bytesRead === 0)
                        break;
                    offset += bytesRead;
                    pending += decoder.write(buffer.subarray(0, bytesRead));
                    let newline = pending.indexOf('\n');
                    while (newline !== -1) {
                        const line = pending.slice(0, newline);
                        pending = pending.slice(newline + 1);
                        if (matches(line))
                            return line;
                        newline = pending.indexOf('\n');
                    }
                }
                return undefined;
            }
            finally {
                await file.close();
            }
        };
        const scan = async () => {
            requested = true;
            if (scanning || settled)
                return;
            scanning = true;
            try {
                while (requested && !settled) {
                    requested = false;
                    const line = await readAvailable();
                    if (line !== undefined)
                        finish({ line });
                }
            }
            catch (error) {
                finish({ error });
            }
            finally {
                scanning = false;
            }
        };
        if (signal?.aborted) {
            abort();
            return;
        }
        signal?.addEventListener('abort', abort, { once: true });
        const start = async () => {
            const parent = await stat(dirname(path));
            if (!parent.isDirectory())
                throw new Error(`Log parent is not a directory: ${dirname(path)}`);
            if (settled)
                return;
            scanTimer = setInterval(() => void scan(), 250);
            void scan();
        };
        void start().catch((error) => finish({ error }));
    });
}
