import { spawnSync } from 'node:child_process';
import { relative, resolve, sep } from 'node:path';

export interface ChangedLineCoverage {
  readonly covered: number;
  readonly executable: number;
  readonly nonExecutable: number;
  readonly unmeasuredFiles: readonly string[];
  readonly uncovered: readonly string[];
}

/** The V8 coverage scope is limited to changed production TypeScript. */
export function isServerCoverageSource(path: string): boolean {
  return path.startsWith('server/') && path.endsWith('.ts')
    && !path.includes('/tests/') && !path.includes('/testdata/')
    && !path.includes('/generated/') && !path.endsWith('.test.ts')
    && !path.endsWith('.integration.test.ts') && !path.endsWith('.d.ts');
}

const mergePatchTimeoutMs = 60_000;

/**
 * The merge tree's zero-context server patch against its base parent, or
 * undefined when git cannot produce it. A persistent self-hosted workspace can
 * be a partial clone; a missing base blob would otherwise be fetched lazily
 * over the uncredentialed remote and hang the shard until the job times out.
 */
export function readMergeServerPatch(cwd: string): string | undefined {
  const patch = spawnSync('git', [
    '-c', 'core.quotePath=false', 'diff', '--no-ext-diff', '--no-renames',
    '--unified=0', 'HEAD^1', 'HEAD', '--', 'server',
  ], {
    cwd,
    encoding: 'utf8',
    maxBuffer: 16 * 1024 * 1024,
    timeout: mergePatchTimeoutMs,
    env: { ...process.env, GIT_NO_LAZY_FETCH: '1', GIT_TERMINAL_PROMPT: '0' },
  });
  return patch.error || patch.status !== 0 ? undefined : patch.stdout;
}

/** Git's zero-context patch identifies new-side lines, including replacements. */
export function changedLinesFromPatch(patch: string): Map<string, Set<number>> {
  const changed = new Map<string, Set<number>>();
  let path: string | undefined;
  let inHeader = false;
  for (const line of patch.split(/\r?\n/)) {
    if (line.startsWith('diff --git ')) {
      path = undefined;
      inHeader = true;
    }
    if (inHeader && line.startsWith('+++ b/')) {
      const candidate = line.slice('+++ b/'.length);
      path = isServerCoverageSource(candidate) ? candidate : undefined;
      if (path && !changed.has(path)) changed.set(path, new Set());
    }
    const hunk = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/.exec(line);
    if (hunk) inHeader = false;
    if (!hunk || !path) continue;
    const first = Number(hunk[1]);
    const count = hunk[2] === undefined ? 1 : Number(hunk[2]);
    for (let offset = 0; offset < count; offset += 1) changed.get(path)!.add(first + offset);
  }
  return changed;
}

function sourcePath(source: string, root: string): string | undefined {
  const path = relative(root, resolve(root, source)).split(sep).join('/');
  return path.startsWith('../') || path === '..' ? undefined : path;
}

/** LCOV's DA records are executable lines; zero hits means uncovered. */
export function lineHitsFromLcov(lcov: string, root: string): Map<string, Map<number, number>> {
  const files = new Map<string, Map<number, number>>();
  let hits: Map<number, number> | undefined;
  for (const line of lcov.split(/\r?\n/)) {
    if (line.startsWith('SF:')) {
      const path = sourcePath(line.slice(3), root);
      hits = path && isServerCoverageSource(path) ? files.get(path) ?? new Map() : undefined;
      if (path && hits) files.set(path, hits);
    } else if (line === 'end_of_record') {
      hits = undefined;
    } else if (hits && line.startsWith('DA:')) {
      const match = /^DA:(\d+),(\d+)(?:,.*)?$/.exec(line);
      if (!match) throw new Error(`Invalid LCOV line record: ${line}`);
      const number = Number(match[1]);
      hits.set(number, (hits.get(number) ?? 0) + Number(match[2]));
    }
  }
  return files;
}

export function summarizeChangedLineCoverage(
  changed: ReadonlyMap<string, ReadonlySet<number>>,
  files: ReadonlyMap<string, ReadonlyMap<number, number>>,
): ChangedLineCoverage {
  let covered = 0;
  let executable = 0;
  let nonExecutable = 0;
  const unmeasuredFiles: string[] = [];
  const uncovered: string[] = [];
  for (const [path, lines] of changed) {
    if (lines.size === 0) continue;
    const hits = files.get(path);
    if (!hits) {
      unmeasuredFiles.push(path);
      continue;
    }
    for (const line of lines) {
      const count = hits.get(line);
      if (count === undefined) {
        nonExecutable += 1;
      } else {
        executable += 1;
        if (count > 0) covered += 1;
        else uncovered.push(`${path}:${line}`);
      }
    }
  }
  return { covered, executable, nonExecutable, unmeasuredFiles, uncovered };
}

export function formatChangedLineCoverage(summary: ChangedLineCoverage, shard: string): string {
  const ratio = summary.executable === 0 ? 'n/a'
    : `${(100 * summary.covered / summary.executable).toFixed(1)}%`;
  const lines = [
    `### Server changed-line coverage, shard ${shard}/4 (shadow)`,
    '',
    `This shard observed ${summary.covered}/${summary.executable} changed executable lines (${ratio}).`,
    'The four shard results are separate observations; this is not merged coverage or an enforcement threshold.',
    `${summary.nonExecutable} changed lines had no executable LCOV record.`,
  ];
  if (summary.unmeasuredFiles.length > 0) {
    lines.push(`Unmeasured files: ${summary.unmeasuredFiles.join(', ')}.`);
  }
  if (summary.uncovered.length > 0) {
    lines.push(`Uncovered in this shard: ${summary.uncovered.join(', ')}.`);
  }
  return `${lines.join('\n')}\n`;
}
