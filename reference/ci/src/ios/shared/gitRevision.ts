import { runCommand } from './processRunner.ts';

/**
 * `git rev-parse HEAD` for a checkout a step is about to trust.
 *
 * Three converted steps ask this question — the base-update classifier, the
 * retained-predecessor controller and the two exact-revision guards — so the
 * invocation lives here once. The directory is passed with `-C` as an
 * argument, never pasted into a command line, and a failed `rev-parse`
 * resolves to the empty string so the caller's comparison rejects it rather
 * than the step dying with git's own message.
 */
export async function headRevision(directory: string): Promise<string> {
  const result = await runCommand('git', ['-C', directory, 'rev-parse', 'HEAD'], {
    capture: true,
  });
  return result.status === 0 ? result.stdout.trim() : '';
}
