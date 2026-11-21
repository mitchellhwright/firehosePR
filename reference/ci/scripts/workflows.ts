import { execFileSync } from 'node:child_process';
import { readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { collectActionVersions, pullVersionsInSource } from 'gagen';
import { renderActionlintRunnerConfig } from '../src/actionlintRunnerConfig.ts';
import { definitions } from '../workflows/all.ts';
import { PINS_PATH, checkDefinitions, loadPins, writeDefinitions } from '../workflows/lib/emit.ts';

/**
 * The workflow generator.
 *
 *   write          regenerate .github/workflows from ci/workflows
 *   check          fail when the committed YAML differs from the definitions
 *   pins           resolve new action tags into the committed pin lockfile
 *   pull-versions  absorb a Dependabot bump in the YAML back into the sources
 *
 * `check` is the one that runs in CI; the others are commands a person runs.
 */

const root = process.cwd();
const command = process.argv[2];
const actionlintPath = join(root, '.github/actionlint.yaml');

function sourceFiles(directory: string): string[] {
  return readdirSync(directory).flatMap((entry) => {
    const path = join(directory, entry);
    if (statSync(path).isDirectory()) return entry === 'lib' ? [] : sourceFiles(path);
    return path.endsWith('.ts') ? [path] : [];
  });
}

function declaredActionReferences(): string[] {
  const references = new Set<string>();
  for (const file of sourceFiles(join(root, 'ci/workflows'))) {
    const source = readFileSync(file, 'utf8');
    for (const match of source.matchAll(/uses:\s*['"]([\w.-]+\/[\w.-]+(?:\/[\w./-]+)?@[^'"]+)['"]/g)) {
      const reference = match[1];
      if (reference !== undefined) references.add(reference);
    }
  }
  return [...references].sort();
}

/** The commit a tag points at, following an annotated tag to its commit. */
function resolveTagToCommit(owner: string, repo: string, tag: string): string {
  const reference = JSON.parse(
    execFileSync('gh', ['api', `repos/${owner}/${repo}/git/ref/tags/${tag}`], { encoding: 'utf8' }),
  ) as { object: { sha: string; type: string } };
  if (reference.object.type === 'commit') return reference.object.sha;
  const annotated = JSON.parse(
    execFileSync('gh', ['api', `repos/${owner}/${repo}/git/tags/${reference.object.sha}`], { encoding: 'utf8' }),
  ) as { object: { sha: string } };
  return annotated.object.sha;
}

function generatedWorkflowSources(): string[] {
  const directory = join(root, '.github/workflows');
  return readdirSync(directory)
    .filter((name) => name.endsWith('.yml') || name.endsWith('.yaml'))
    .map((name) => readFileSync(join(directory, name), 'utf8'));
}

switch (command) {
  case 'write': {
    for (const path of writeDefinitions(definitions, root)) console.log(`wrote ${path}`);
    writeFileSync(actionlintPath, renderActionlintRunnerConfig(definitions));
    console.log('wrote .github/actionlint.yaml');
    break;
  }

  case 'check': {
    const reports = checkDefinitions(definitions, root);
    for (const report of reports) {
      const reason = report.reason === 'missing'
        ? 'the generated CI artifact is missing'
        : 'the generated CI artifact differs from its TypeScript source';
      console.log(`::error file=${report.path}::${reason}; run npm run ci:workflows and commit the result`);
      if (report.diff) console.log(report.diff);
    }
    if (readFileSync(actionlintPath, 'utf8') !== renderActionlintRunnerConfig(definitions)) {
      console.log('::error file=.github/actionlint.yaml::runner labels differ from typed workflow routes; run npm run ci:workflows and commit the result');
      process.exitCode = 1;
    }
    if (reports.length > 0) process.exit(1);
    if (process.exitCode === 1) break;
    console.log(`${definitions.length} generated workflows in sync with their definitions; generated action artifacts in sync`);
    break;
  }

  case 'pins': {
    const pins = loadPins(root);
    let added = 0;
    for (const reference of declaredActionReferences()) {
      if (pins.has(reference)) continue;
      const [repository, tag] = reference.split('@');
      const [owner, repo] = (repository ?? '').split('/');
      if (!owner || !repo || !tag) throw new Error(`Cannot parse the action reference ${reference}`);
      pins.set(reference, resolveTagToCommit(owner, repo, tag));
      console.log(`pinned ${reference}`);
      added += 1;
    }
    const sorted = Object.fromEntries([...pins.entries()].sort(([left], [right]) => left.localeCompare(right)));
    writeFileSync(join(root, PINS_PATH), `${JSON.stringify(sorted, null, 2)}\n`);
    console.log(added === 0 ? 'every declared action was already pinned' : `${added} action(s) pinned`);
    break;
  }

  case 'pull-versions': {
    const { versions, conflicts } = collectActionVersions(generatedWorkflowSources());
    for (const [action, refs] of conflicts) {
      console.log(`::warning::${action} appears with conflicting versions ${refs.join(', ')}; resolve it by hand`);
    }
    for (const file of sourceFiles(join(root, 'ci/workflows'))) {
      const { content, changes } = pullVersionsInSource(readFileSync(file, 'utf8'), versions);
      if (changes.length === 0) continue;
      writeFileSync(file, content);
      for (const change of changes) console.log(`${file}: ${change.action} ${change.from} -> ${change.to}`);
    }
    console.log('pulled every action version from the generated workflows into the definitions');
    break;
  }

  default:
    console.error('usage: workflows.ts write|check|pins|pull-versions');
    process.exit(2);
}
