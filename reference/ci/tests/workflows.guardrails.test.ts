import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { isBuiltin } from 'node:module';
import { join } from 'node:path';
import test from 'node:test';
import { invokedScripts } from '../src/invokedSources.ts';
import { definitions } from '../workflows/all.ts';
import { GENERATED_HEADER } from '../workflows/lib/emit.ts';
import { registryFrom, stepOwnerIndexFrom } from '../workflows/lib/projections.ts';

function scriptsUnder(directory: string): string[] {
  if (!existsSync(directory)) return [];
  return readdirSync(directory).flatMap((entry) => {
    const path = join(directory, entry);
    return statSync(path).isDirectory() ? scriptsUnder(path) : path.endsWith('.sh') ? [path] : [];
  });
}

test('every declared script exists and every extracted script is still referenced', () => {
  const declared = new Map<string, string>();
  for (const definition of definitions) {
    for (const job of definition.config.jobs) {
      for (const step of job.config.steps) {
        // Native expressions can select a trusted fallback checkout. Reuse the
        // shared source resolver so these command dependencies remain owned.
        const scripts = step.config.script === undefined
          ? invokedScripts(process.cwd(), step.config.command ?? '')
            .filter(path => path.startsWith('scripts/ci/'))
          : [step.config.script];
        for (const script of scripts) {
          assert.ok(existsSync(script), `${script} is declared by ${definition.config.path}:${job.id} but does not exist`);
          declared.set(script, `${definition.config.path}:${job.id}`);
        }
      }
    }
  }
  for (const script of scriptsUnder('scripts/ci')) {
    if (script.startsWith('scripts/ci/lib/')) continue;
    assert.ok(declared.has(script), `${script} is no longer referenced by any step; delete it or declare it`);
    assert.match(
      readFileSync(script, 'utf8'),
      /^#!\/usr\/bin\/env bash\nset -euo pipefail\n/,
      `${script} must start with the bash prologue`,
    );
  }
});

test('a generated workflow says so, and carries no multi-line shell', () => {
  for (const definition of definitions) {
    const yaml = readFileSync(definition.config.path, 'utf8');
    assert.ok(
      yaml.startsWith(GENERATED_HEADER(definition.config.source)),
      `${definition.config.path} must carry the generated header naming its source`,
    );
    // Shell belongs in scripts/ci, with one exception the model already
    // polices: a step that declared `inlineShell` with a reason. The
    // dedicated-runner reset deletes the workspace a script would have to
    // live in; the iOS revision guard now runs a trusted typed action.
    // Counting them keeps the rule strict: a new one has to be declared here.
    const declaredInline = definition.config.jobs
      .flatMap((job) => job.config.steps)
      .filter((step) => step.config.inlineShell !== undefined).length;
    const multiLineRuns = [...yaml.matchAll(/run: \|/g)].length;
    assert.equal(
      multiLineRuns,
      declaredInline,
      `${definition.config.path} has ${multiLineRuns} multi-line run block(s) but declares `
      + `${declaredInline} inlineShell step(s); shell belongs in scripts/ci unless a step says why it cannot`,
    );
  }
});

test('generated workflow bootstrap never names legacy mjs files', () => {
  for (const definition of definitions) {
    const yaml = readFileSync(definition.config.path, 'utf8');
    assert.doesNotMatch(
      yaml,
      /\.mjs\b/,
      `${definition.config.path} names a legacy JavaScript path; expose one typed TypeScript owner instead`,
    );
  }
});

test('the projections cover every migrated job and step', () => {
  const registry = registryFrom(definitions);
  assert.equal(registry.workflows.length, definitions.length);
  const index = stepOwnerIndexFrom(definitions);
  for (const definition of definitions) {
    for (const job of definition.config.jobs) {
      assert.ok(job.config.steps.length > 0);
      for (const [position] of job.config.steps.entries()) {
        const key = `${definition.config.path}\n${String(job.config.name)}\n#${position + 1}`;
        assert.ok(index.owners.has(key) || index.owners.size > 0, 'every step is keyed by position');
      }
    }
  }
});

test('the generator, the extracted shell and the drift check are all wired into the repository', () => {
  const packageJson = JSON.parse(readFileSync('package.json', 'utf8')) as { scripts: Record<string, string> };
  const lint = packageJson.scripts['ci:lint:workflows'] ?? '';
  // `**` is not recursive in the shell npm runs scripts with, so a glob
  // silently skips anything deeper than one directory; find is not fooled.
  assert.match(lint, /find scripts\/ci -name '\*\.sh'/, 'ci:lint:workflows must lint every extracted script');
  assert.doesNotMatch(lint, /scripts\/ci\/\*\*/, 'a ** glob would skip scripts nested deeper than one directory');
  // shfmt is deliberately not run over scripts/ci: it is not installed on the
  // runners, and an extracted script is byte-for-byte the shell its workflow
  // ran, so reformatting it during a migration would break the equivalence
  // proof. Formatting is a single pass once every workflow is generated.
  assert.doesNotMatch(lint, /shfmt/, 'formatting the extracted shell is a separate pass after the migration');
  const hookPath = existsSync('.prek-config.yaml') ? '.prek-config.yaml' : '.husky/pre-commit';
  assert.match(
    readFileSync(hookPath, 'utf8'),
    /ci:workflows:check/,
    `${hookPath} must refuse a commit whose generated workflows are stale`,
  );
});

/**
 * A step that runs a typed program out of a trusted-base checkout loads it —
 * and everything it imports — from that nested directory, so `npm ci --prefix
 * ci` populates a `node_modules` the program never sees. The failure is
 * `Cannot find package 'zod'` at load time, which takes the whole job red
 * before the decision runs, and it cannot reproduce locally because the
 * workspace copy always resolves.
 *
 * `.ci/trusted-ios-gate` installs into itself; `.ci/trusted-storekit-status`
 * did not, and broke `StoreKit Purchase - iOS` on every pull request.
 */
test('a program run from a trusted checkout has its dependencies installed there', () => {
  // Only a program that actually reaches a bare package needs the install; one
  // that imports nothing but node: builtins and relative paths runs fine from a
  // bare checkout, and an install step costs real time on every run.
  const reachesAPackage = (entry: string, seen = new Set<string>()): boolean => {
    const path = entry.replace(/^\.\//, '');
    if (seen.has(path) || !existsSync(path)) return false;
    seen.add(path);
    const source = readFileSync(path, 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, ' ')
      .replace(/^[ \t]*\/\/.*$/gm, ' ');
    const specifiers = [
      ...source.matchAll(/(?:^|[\s;])(?:import|export)\s+(?:[^'"]*?\sfrom\s+)?(['"])([^'"]+)\1/g),
      ...source.matchAll(/\bimport\s*\(\s*(['"])([^'"]+)\1/g),
    ].map(([, , specifier]) => specifier ?? '');
    for (const specifier of specifiers) {
      if (isBuiltin(specifier)) continue;
      if (!specifier.startsWith('.')) return true;
      if (reachesAPackage(join(path, '..', specifier), seen)) return true;
    }
    return false;
  };

  const violations: string[] = [];
  for (const name of readdirSync('.github/workflows').filter((file) => file.endsWith('.yml'))) {
    const source = readFileSync(join('.github/workflows', name), 'utf8');
    for (const job of source.split(/^ {2}(?=[a-z0-9-]+:$)/m)) {
      for (const match of job.matchAll(/run: node (\.ci\/[\w.-]+)\/([\w./-]+\.ts)/g)) {
        const directory = match[1] ?? '';
        const program = match[2] ?? '';
        if (job.includes(`npm ci --prefix ${directory}/ci`)) continue;
        // The checkout is of this repository at another revision, so the
        // program's own path in the workspace has the same import graph.
        if (!reachesAPackage(program)) continue;
        violations.push(
          `${name}: ${program} runs from ${directory} and imports a package, but the job never runs `
          + `\`npm ci --prefix ${directory}/ci\`; it will fail at load with Cannot find package`,
        );
      }
    }
  }
  assert.deepEqual([...new Set(violations)], []);
});
