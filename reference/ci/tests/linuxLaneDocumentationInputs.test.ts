import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { it } from 'node:test';
import {
  LINUX_LANE_DOCUMENTATION_INPUTS,
  LINUX_LANE_EXCLUDED_ROOT_ENTRIES,
} from '../src/queueLaneEvidence.ts';

/** Scan source text without executing it; the lint lane runs this for every source PR. */
function sourceFiles(root: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(root)) {
    if (entry === 'node_modules' || entry === 'dist' || entry === '.next') continue;
    const path = join(root, entry);
    if (statSync(path).isDirectory()) files.push(...sourceFiles(path));
    else if (/\.(ts|tsx|mts|cts|js|jsx|mjs|cjs|sh|bash|zsh|py|yml|yaml)$/.test(entry)) files.push(path);
  }
  return files;
}

function documentationReferences(files: readonly string[]): string[] {
  // A read may be relative to its file, including a new URL with import.meta.url.
  const literal = /['"`]((?:\.\.\/)*)(docs\/[^'"`\s$\\]*)/g;
  const bare = /(?:^|[\s=:(])((?:\.\.\/)*)(docs\/[A-Za-z0-9._/-]+)/g;
  // path.join/process.cwd() and equivalent calls often spell the root as a
  // separate segment. Recording the first following literal as a path (or a
  // directory) conservatively covers any later segments in the same call.
  const segments = /['"`]docs['"`]\s*,\s*['"`]([^'"`$]+)['"`]/g;
  const referenced = new Set<string>();
  for (const file of files) {
    const content = readFileSync(file, 'utf8');
    const addReference = (match: RegExpMatchArray): void => {
      const prefix = match[1] ?? '';
      const path = (match[2] ?? '').replace(/[.,;:]+$/, '');
      const rootPath = prefix ? relative(process.cwd(), resolve(dirname(file), prefix, path)) : path;
      if (rootPath.startsWith('docs/')) referenced.add(rootPath);
    };
    for (const match of content.matchAll(literal)) addReference(match);
    for (const match of content.matchAll(segments)) {
      const segment = (match[1] ?? '').replace(/^\/+|\/+$/g, '');
      if (segment) referenced.add(`docs/${segment}`);
    }
    if (/\.(?:yml|yaml|sh|bash|zsh)$/.test(file)) {
      for (const match of content.matchAll(bare)) addReference(match);
    }
  }
  return [...referenced].filter((path) => path !== 'docs/').sort();
}

it('finds documentation references in every source format, including absent files', () => {
  const root = mkdtempSync(join(tmpdir(), 'example-linux-doc-inputs-'));
  try {
    const extensions = ['ts', 'tsx', 'mts', 'cts', 'js', 'jsx', 'mjs', 'cjs', 'sh', 'bash', 'zsh', 'py', 'yml', 'yaml'];
    for (const extension of extensions) {
      writeFileSync(join(root, `reader.${extension}`), `read("${'doc' + 's/'}missing-${extension}.md")\n`);
    }
    mkdirSync(join(root, '.github', 'workflows'), { recursive: true });
    writeFileSync(join(root, '.github', 'workflows', 'read.yml'),
      `steps:\n  - run: cat ${'doc' + 's/'}missing-workflow.json\n`);
    mkdirSync(join(root, 'ci', 'workflows'), { recursive: true });
    mkdirSync(join(root, 'ci', 'scripts'), { recursive: true });
    writeFileSync(join(root, 'ci', 'workflows', 'read.ts'),
      `readFileSync(join(process.cwd(), '${'doc' + 's'}', 'missing-workflow-source.json'))\n`);
    writeFileSync(join(root, 'ci', 'scripts', 'read.ts'),
      `readFileSync(join(process.cwd(), '${'doc' + 's'}', 'missing-script.json'))\n`);
    assert.deepEqual(documentationReferences(sourceFiles(root)),
      [...extensions.map((extension) => `${'doc' + 's/'}missing-${extension}.md`),
        `${'doc' + 's/'}missing-workflow.json`, `${'doc' + 's/'}missing-workflow-source.json`,
        `${'doc' + 's/'}missing-script.json`].sort());
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

it('declares every documentation path a Linux lane reads', () => {
  assert.deepEqual([...LINUX_LANE_EXCLUDED_ROOT_ENTRIES], ['docs']);
  const files: string[] = [];
  for (const root of ['.github', 'server', 'ci', 'scripts', 'shared', 'src', 'pages']) {
    files.push(...sourceFiles(join(process.cwd(), root)));
  }
  const referenced = documentationReferences(files);
  assert.ok(referenced.includes('docs/github-repository-security.md'), 'the scan must find the known reads');
  const declared = new Set<string>(LINUX_LANE_DOCUMENTATION_INPUTS);
  const undeclared = referenced.filter((path) => ![...declared].some((input) => path === input || path.startsWith(`${input}/`)));
  assert.deepEqual(undeclared, [], 'a documentation path read by Linux lane code must be a declared lane input');
  assert.deepEqual([...LINUX_LANE_DOCUMENTATION_INPUTS], [...LINUX_LANE_DOCUMENTATION_INPUTS].sort());
});
