import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

export function primaryHealthUrl(port: string | undefined): string {
  if (port === undefined || !/^[0-9]+$/.test(port) || Number(port) < 1 || Number(port) > 65535) {
    throw new Error('Primary health probe requires a valid PORT');
  }
  return `http://127.0.0.1:${port}/health`;
}

/** Native Docker schedules this dependency-free, bounded probe. */
export async function primaryImageHealthy(port: string | undefined, request: typeof fetch = fetch): Promise<boolean> {
  try {
    const response = await request(primaryHealthUrl(port), { signal: AbortSignal.timeout(2_000) });
    // The probe only needs the status. Dispose of any body to release the connection.
    await response.body?.cancel();
    return response.ok;
  } catch {
    return false;
  }
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  process.exitCode = process.argv.length === 3 && process.argv[2] === '/health' && await primaryImageHealthy(process.env['PORT']) ? 0 : 1;
}
