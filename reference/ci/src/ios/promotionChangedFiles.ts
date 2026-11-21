import { execFileSync } from 'node:child_process';
import { z } from 'zod';
import { ensureIosMergeBase } from '../actions/ios/ensureIosMergeBase.ts';

const sha = z.string().regex(/^[a-f0-9]{40}$/u);

/**
 * Every path the promotion source changes relative to its merge base with the
 * production base (GitHub's `base...source`), read from Git history.
 *
 * GitHub's compare API caps a response at 300 files and 250 commits, so it
 * cannot prove a large promotion's inventory complete. The exact base and
 * source are fetched by `ensureIosMergeBase`, which fails closed when either
 * immutable revision cannot be proven. A rename or copy contributes both paths.
 */
export function promotionChangedFiles(input: {
  readonly baseSha: string;
  readonly sourceSha: string;
  readonly remote: string;
  readonly cwd: string;
  readonly env?: NodeJS.ProcessEnv;
}): string {
  const base = sha.parse(input.baseSha);
  const source = sha.parse(input.sourceSha);
  const mergeBase = ensureIosMergeBase({
    baseSha: base,
    headSha: source,
    remote: input.remote,
    cwd: input.cwd,
    ...(input.env === undefined ? {} : { env: input.env }),
  });
  const output = execFileSync('git', [
    'diff', '--name-status', '-z', '-M', '-C', '--find-copies-harder', '--no-color', '--no-ext-diff',
    mergeBase, source,
  ], {
    cwd: input.cwd,
    env: input.env,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    maxBuffer: 64 * 1024 * 1024,
  });
  return [...changedPaths(output)].join('\n');
}

/** Parses `git diff --name-status -z`: rename/copy records carry two paths. */
function changedPaths(output: string): ReadonlySet<string> {
  const fields = output.split('\0');
  if (fields.at(-1) === '') fields.pop();
  const paths = new Set<string>();
  for (let index = 0; index < fields.length;) {
    const status = fields[index] ?? '';
    const pathCount = /^[RC]/u.test(status) ? 2 : 1;
    const recordPaths = fields.slice(index + 1, index + 1 + pathCount);
    if (!/^[ACDMRTUX][0-9]*$/u.test(status) || recordPaths.length !== pathCount
      || recordPaths.includes('')) {
      throw new Error(`Unparseable promotion diff record near "${status}".`);
    }
    for (const path of recordPaths) paths.add(path);
    index += 1 + pathCount;
  }
  return paths;
}
