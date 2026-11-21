import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, extname, join, relative } from 'node:path';
import { spawnSync } from 'node:child_process';
import { load } from 'js-yaml';
import { parseJsonConfigFileContent, readConfigFile, sys } from 'typescript';
import { z } from 'zod';

/**
 * Measures how much of the CI surface is proved at compile time and how much
 * is still untyped, from the tree. `ci:coverage` prints it; `ci:coverage:check`
 * (inside `ci:check`) enforces `ci/contracts/typing-coverage-floor.json`:
 * typed CI entry points may only rise, unreachable scripts and inline shell
 * lines may only fall, and a value moves only in the change that earns it.
 */

const workflowSchema = z.object({
  jobs: z.record(z.string(), z.object({
    steps: z.array(z.object({ run: z.unknown().optional() }).passthrough()).optional(),
  }).passthrough()),
}).passthrough();

const floorSchema = z.object({
  typedEntryPoints: z.number().int().nonnegative(),
  topLevelMjs: z.number().int().nonnegative(),
  unreachableScripts: z.number().int().nonnegative(),
  inlineShellLines: z.number().int().nonnegative(),
}).passthrough();

/** Expand declared root entries and CI-owned script directories exactly as `tsc` does. */
export function scriptsTypecheckEntries(root: string): readonly string[] {
  const configPath = join(root, 'ci/tsconfig.scripts.json');
  if (!existsSync(configPath)) return [];
  const config = readConfigFile(configPath, sys.readFile);
  if (config.error) throw new Error(`Cannot read ${configPath}: ${config.error.messageText}`);
  const parsed = parseJsonConfigFileContent(config.config, sys, dirname(configPath));
  if (parsed.errors.length > 0) {
    throw new Error(`Cannot parse ${configPath}: ${parsed.errors.map((error) => error.messageText).join('; ')}`);
  }
  return parsed.fileNames.map((path) => relative(root, path).replaceAll('\\', '/'))
    .filter((path) => path.startsWith('scripts/'));
}

export interface TypingCoverageReport {
  readonly workflows: {
    readonly files: number; readonly jobs: number; readonly steps: number;
    readonly runSteps: number; readonly usesSteps: number; readonly yamlLines: number;
    readonly runLines: number; readonly inlineShellLines: number;
  };
  readonly provedReferences: { readonly needs: number; readonly stepOutputs: number; readonly env: number };
  readonly typedLayer: { readonly files: number; readonly lines: number };
  readonly scripts: {
    readonly byLanguage: Readonly<Record<string, { files: number; lines: number }>>;
    readonly topLevelMjs: number;
    readonly totalMjs: number;
    readonly totalTs: number;
    readonly legacyMjsTests: number;
    readonly typeCheckedScripts: number;
    readonly typeCheckedMjs: number;
    readonly typeCheckedTs: number;
    readonly typeCheckedLines: number;
    readonly uncheckedReachableTs: readonly string[];
  };
  readonly unreachableScripts: { readonly files: number; readonly lines: number; readonly paths: readonly string[] };
  readonly lint: { readonly actionlint: boolean; readonly shellcheck: boolean };
}

function walk(directory: string, predicate: (path: string) => boolean, out: string[] = [], includeTests = false): string[] {
  if (!existsSync(directory)) return out;
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      if (!/node_modules|\/dist$|\/\.git$/.test(path) && (includeTests || !path.endsWith('/tests'))) {
        walk(path, predicate, out, includeTests);
      }
    } else if (predicate(path)) out.push(path);
  }
  return out;
}

const lineCount = (path: string): number => readFileSync(path, 'utf8').split('\n').length;

/** A single launcher needs a run block, but adds no maintained shell logic. */
function isDirectLauncher(script: string): boolean {
  const command = script.trim();
  if (command.includes('\n') || /[;&|<>$`\\]/.test(command)) return false;
  return /^node (?:\.\.\/)?ci\/src\/actions\/[\w./-]+\.ts(?: [\w./-]+)*$/.test(command)
    || /^npm ci(?: [\w./-]+)*$/.test(command);
}

function referencedScripts(text: string, scripts: readonly string[], root: string): Set<string> {
  const out = new Set<string>();
  for (const path of scripts) {
    const rel = path.slice(root.length + 1);
    const base = rel.split('/').pop() ?? rel;
    if (text.includes(rel) || text.includes(`./${base}`) || text.includes(`/${base}`) || text.includes(`'${base}`) || text.includes(`"${base}`)) out.add(path);
  }
  return out;
}

export function measureTypingCoverage(root = process.cwd()): TypingCoverageReport {
  const workflowDir = join(root, '.github/workflows');
  const workflows = readdirSync(workflowDir).filter((name) => name.endsWith('.yml')).map((name) => join(workflowDir, name));
  let jobs = 0; let steps = 0; let runSteps = 0; let runLines = 0; let inlineShellLines = 0; let yamlLines = 0;
  let stepOutputRefs = 0; let envRefs = 0; let needsRefs = 0;
  for (const path of workflows) {
    const source = readFileSync(path, 'utf8');
    yamlLines += source.split('\n').length;
    const graph = workflowSchema.parse(load(source));
    for (const job of Object.values(graph.jobs)) {
      jobs += 1;
      for (const step of job.steps ?? []) {
        steps += 1;
        if (step.run !== undefined) {
          runSteps += 1;
          const script = String(step.run);
          const lines = script.split('\n').length;
          runLines += lines;
          if (!isDirectLauncher(script)) inlineShellLines += lines;
        }
      }
      const text = JSON.stringify(job);
      stepOutputRefs += (text.match(/steps\.[A-Za-z0-9_-]+\.outputs\.[A-Za-z0-9_-]+/g) ?? []).length;
      envRefs += (text.match(/\$\{\{[^}]*\benv\.[A-Za-z_][A-Za-z0-9_]*/g) ?? []).length;
      needsRefs += (text.match(/needs\.[A-Za-z0-9_-]+\.(?:outputs\.[A-Za-z0-9_-]+|result)/g) ?? []).length;
    }
  }

  const typedFiles = walk(join(root, 'ci/src'), (path) => path.endsWith('.ts'));
  const typedLines = typedFiles.reduce((sum, path) => sum + lineCount(path), 0);

  const scriptsDir = join(root, 'scripts');
  // Include legacy test scripts in the inventory. They run in workflow
  // contracts, even though test-only files are excluded from the orphan
  // ratchet because they do not need a production entry point.
  const scripts = walk(scriptsDir, (path) => /\.(mjs|js|cjs|sh|py|ts)$/.test(path), [], true);
  const byLanguage: Record<string, { files: number; lines: number }> = {};
  for (const path of scripts) {
    const language = extname(path).slice(1);
    const entry = byLanguage[language] ?? { files: 0, lines: 0 };
    entry.files += 1;
    entry.lines += lineCount(path);
    byLanguage[language] = entry;
  }
  const checkedScripts = scriptsTypecheckEntries(root);
  const checkedScriptPaths = new Set(checkedScripts.filter((file) => existsSync(join(root, file))));
  const checkedLines = checkedScripts.reduce((sum, file) => sum + (existsSync(join(root, file)) ? lineCount(join(root, file)) : 0), 0);
  const topLevelMjs = readdirSync(scriptsDir).filter((name) => name.endsWith('.mjs')).length;

  const entryTexts = workflows.map((path) => readFileSync(path, 'utf8'));
  for (const path of walk(join(root, '.github/actions'), (p) => /\.(yml|yaml|mjs|js|ts|sh)$/.test(p))) entryTexts.push(readFileSync(path, 'utf8'));
  // A converted step invokes its scripts from the typed layer rather than from
  // the workflow's shell, so the typed layer is an entry point too. Without
  // this, every conversion would report the scripts it still calls as orphans.
  for (const path of typedFiles) entryTexts.push(readFileSync(path, 'utf8'));
  for (const name of readdirSync(root)) {
    if (/^cloudbuild.*\.ya?ml$/.test(name) || name === 'package.json') entryTexts.push(readFileSync(join(root, name), 'utf8'));
  }
  // Platform repair commands are run by an operator from this runbook rather
  // than from CI. Their documented invocations are real entry points.
  const platformRunbook = join(root, 'terraform/platform/README.md');
  if (existsSync(platformRunbook)) entryTexts.push(readFileSync(platformRunbook, 'utf8'));
  const scriptText = new Map(scripts.map((path) => [path, readFileSync(path, 'utf8')] as const));
  const scriptTestsDir = join(scriptsDir, 'tests') + '/';
  const live = new Set<string>();
  const queue: string[] = [];
  for (const text of entryTexts) for (const path of referencedScripts(text, scripts, root)) if (!live.has(path)) { live.add(path); queue.push(path); }
  while (queue.length > 0) {
    const path = queue.pop() ?? '';
    // Contract suites belong in the inventory, but a test naming a helper
    // cannot make that helper reachable from a production entry point.
    if (path.startsWith(scriptTestsDir)) continue;
    for (const next of referencedScripts(scriptText.get(path) ?? '', scripts, root)) if (!live.has(next)) { live.add(next); queue.push(next); }
  }
  const unreachable = scripts.filter((path) => !path.startsWith(scriptTestsDir) && !live.has(path));
  const uncheckedReachableTs = scripts
    .filter((path) => path.endsWith('.ts') && live.has(path) && !checkedScriptPaths.has(path.slice(root.length + 1)))
    .map((path) => path.slice(root.length + 1)).sort();
  const hasBinary = (name: string): boolean => spawnSync(name, ['--version'], { stdio: 'ignore' }).status === 0;

  return {
    workflows: { files: workflows.length, jobs, steps, runSteps, usesSteps: steps - runSteps, yamlLines, runLines, inlineShellLines },
    provedReferences: { needs: needsRefs, stepOutputs: stepOutputRefs, env: envRefs },
    typedLayer: { files: typedFiles.length, lines: typedLines },
    scripts: {
      byLanguage,
      topLevelMjs,
      totalMjs: scripts.filter((path) => path.endsWith('.mjs')).length,
      totalTs: scripts.filter((path) => path.endsWith('.ts')).length,
      legacyMjsTests: scripts.filter((path) => path.startsWith(join(scriptsDir, 'tests') + '/') && path.endsWith('.test.mjs')).length,
      typeCheckedScripts: checkedScriptPaths.size,
      typeCheckedMjs: [...checkedScriptPaths].filter((path) => path.startsWith('scripts/') && path.endsWith('.mjs')).length,
      typeCheckedTs: [...checkedScriptPaths].filter((path) => path.startsWith('scripts/') && path.endsWith('.ts')).length,
      typeCheckedLines: checkedLines,
      uncheckedReachableTs,
    },
    unreachableScripts: {
      files: unreachable.length,
      lines: unreachable.reduce((sum, path) => sum + lineCount(path), 0),
      paths: unreachable.map((path) => path.slice(root.length + 1)).sort(),
    },
    lint: { actionlint: hasBinary('actionlint'), shellcheck: hasBinary('shellcheck') },
  };
}

export function formatTypingCoverage(report: TypingCoverageReport): string {
  const pct = (part: number, whole: number): string => (whole === 0 ? '0' : ((part / whole) * 100).toFixed(1));
  const { workflows, provedReferences, typedLayer, scripts, unreachableScripts, lint } = report;
  const languages = Object.entries(scripts.byLanguage).map(([language, value]) => `${language} ${value.files} files/${value.lines} lines`).join(', ');
  return [
    'CI typing coverage',
    `  workflows: ${workflows.files} files, ${workflows.jobs} jobs, ${workflows.steps} steps (${workflows.runSteps} run / ${workflows.usesSteps} uses)`,
    `  YAML lines: ${workflows.yamlLines}; inside run: blocks: ${workflows.runLines}, maintained shell: ${workflows.inlineShellLines} (${pct(workflows.inlineShellLines, workflows.yamlLines)}% of YAML)`,
    `  references proved by ci:check: needs ${provedReferences.needs}, step outputs ${provedReferences.stepOutputs}, env ${provedReferences.env}`,
    `  typed layer (ci/src): ${typedLayer.files} files, ${typedLayer.lines} lines`,
    `  scripts: ${languages}`,
    `  scripts under strict tsc: ${scripts.typeCheckedMjs}/${scripts.totalMjs} .mjs, ${scripts.typeCheckedTs}/${scripts.totalTs} .ts (${scripts.typeCheckedLines} lines total); legacy .mjs tests: ${scripts.legacyMjsTests}`,
    `  unreachable scripts: ${unreachableScripts.files} files, ${unreachableScripts.lines} lines`,
    `  lint gates available here: actionlint=${lint.actionlint} shellcheck=${lint.shellcheck}`,
  ].join('\n');
}

/** Surfaces that regressed below the pinned floor, empty when none did. */
export function typingCoverageRegressions(report: TypingCoverageReport, floorPath: string): string[] {
  const floor = floorSchema.parse(JSON.parse(readFileSync(floorPath, 'utf8')));
  const failures: string[] = [];
  const typedEntryPoints = report.typedLayer.files + report.scripts.typeCheckedScripts;
  if (typedEntryPoints < floor.typedEntryPoints) {
    failures.push(`typed CI entry points ${typedEntryPoints} < floor ${floor.typedEntryPoints}`);
  }
  if (report.scripts.topLevelMjs > floor.topLevelMjs) {
    failures.push(`top-level .mjs scripts ${report.scripts.topLevelMjs} > ceiling ${floor.topLevelMjs}`);
  }
  if (report.unreachableScripts.files > floor.unreachableScripts) failures.push(`unreachable scripts ${report.unreachableScripts.files} > ceiling ${floor.unreachableScripts}`);
  if (report.workflows.inlineShellLines > floor.inlineShellLines) failures.push(`inline shell lines ${report.workflows.inlineShellLines} > ceiling ${floor.inlineShellLines}`);
  if (report.scripts.uncheckedReachableTs.length > 0) {
    failures.push(`reachable TypeScript scripts omitted from strict tsc: ${report.scripts.uncheckedReachableTs.join(', ')}`);
  }
  return failures;
}
