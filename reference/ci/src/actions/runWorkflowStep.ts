import { spawnSync } from 'node:child_process';
import { appendFileSync, existsSync, statSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * Node 24 action runtime for typed entrypoints and legacy script steps. Its metadata and executable
 * are generated from the TypeScript sources by `npm run ci:workflows`.
 *
 * GitHub supplies this action's Node runtime, including for jobs whose first
 * script precedes `actions/setup-node`. The child shell remains until each
 * individual script has a typed replacement. Once selected by the workflow
 * generator, it replaces the shared shell annotation wrapper without changing
 * those scripts' execution contract.
 */

function required(name: string): string {
  const value = process.env[name];
  if (value === undefined || value.length === 0) throw new Error(`${name} is required`);
  return value;
}

function summaryLength(path: string): number {
  return existsSync(path) ? statSync(path).size : 0;
}

function escapeData(value: string): string {
  return value.replaceAll('%', '%25').replaceAll('\r', '%0D').replaceAll('\n', '%0A');
}

function escapeProperty(value: string): string {
  return escapeData(value).replaceAll(':', '%3A').replaceAll(',', '%2C');
}

function main(): void {
  const script = process.env.INPUT_SCRIPT || undefined;
  const entry = process.env.INPUT_ENTRY || undefined;
  if ((script === undefined) === (entry === undefined)) {
    throw new Error('Exactly one of INPUT_SCRIPT or INPUT_ENTRY is required');
  }
  if (script !== undefined && (!/^scripts\/[a-zA-Z0-9_./-]+\.sh$/.test(script) || script.split('/').includes('..'))) {
    throw new Error(`INPUT_SCRIPT must be a repository script under scripts/: ${script}`);
  }
  if (entry !== undefined && (!/^ci\/src\/actions\/[a-zA-Z0-9_./-]+\.ts$/.test(entry) || entry.split('/').includes('..'))) {
    throw new Error(`INPUT_ENTRY must be a typechecked entrypoint under ci/src/actions/: ${entry}`);
  }
  const name = required('EXAMPLE_STEP_NAME');
  const owner = required('EXAMPLE_STEP_OWNER');
  const nextAction = required('EXAMPLE_STEP_NEXT_ACTION');
  const workspace = resolve(required('GITHUB_WORKSPACE'));
  const summary = process.env.GITHUB_STEP_SUMMARY;
  const before = summary === undefined || summary.length === 0 ? 0 : summaryLength(summary);

  const child = script !== undefined
    ? spawnSync('bash', [script], { cwd: workspace, env: process.env, stdio: 'inherit' })
    // The job's setup-node step selects the toolchain on PATH. The action's
    // own node24 executable is only its bootstrap runtime, not the test runtime.
    : spawnSync('node', [entry ?? ''], { cwd: workspace, env: process.env, stdio: 'inherit' });
  const status = child.status ?? 1;
  if (status !== 0) {
    const capitalizedOwner = `${owner[0]?.toUpperCase() ?? ''}${owner.slice(1)}`;
    const detail = `${capitalizedOwner} owner — ${nextAction}`;
    process.stdout.write(`::error title=${escapeProperty(name)}::${escapeData(detail)}\n`);
    if (summary !== undefined && summary.length > 0) {
      appendFileSync(summary, `- ❌ ${name}: ${nextAction}\n`);
    }
    if (child.error !== undefined) process.stderr.write(`${child.error.message}\n`);
    process.exitCode = status;
    return;
  }

  const title = process.env.EXAMPLE_SUMMARY_TITLE;
  if (title !== undefined && title.length > 0 && summary !== undefined && summary.length > 0
    && existsSync(summary) && summaryLength(summary) === before) {
    appendFileSync(summary, `## ${title}\n\n(no summary written)\n`);
  }
}

try {
  main();
} catch (error: unknown) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
}
