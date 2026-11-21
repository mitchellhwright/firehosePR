import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { load } from 'js-yaml';
import { z } from 'zod';
import {
  isStepActionEntryPath, isStepActionScriptPath, STEP_ACTION_ENTRY_INPUT,
  STEP_ACTION_REFERENCE, STEP_ACTION_SCRIPT_INPUT,
} from '../workflows/lib/stepActionContract.ts';

const workflowStepSchema = z.object({
  name: z.string().optional(),
  run: z.string().optional(),
  uses: z.string().optional(),
  with: z.record(z.string(), z.unknown()).optional(),
  env: z.record(z.string(), z.unknown()).optional(),
}).passthrough();
const workflowJobSchema = z.object({
  steps: z.array(workflowStepSchema).optional(),
}).passthrough();
const workflowDocumentSchema = z.object({
  jobs: z.record(z.string(), workflowJobSchema),
}).passthrough();

export type WorkflowDocument = z.infer<typeof workflowDocumentSchema>;
export type WorkflowJob = z.infer<typeof workflowJobSchema>;

/**
 * Read a workflow's structure and a step's shell without caring whether the
 * workflow is hand-written or generated, or whether the shell is inline or in
 * a script under scripts/ci. Tests that assert on what a workflow *does*
 * should use this; tests that assert on YAML text break the moment a
 * generator chooses different quoting for the same value.
 */

const repositoryRoot = new URL('../../', import.meta.url);

export function workflowDocument(name: string): WorkflowDocument {
  return workflowDocumentSchema.parse(
    load(readFileSync(new URL(`.github/workflows/${name}`, repositoryRoot), 'utf8')),
  );
}

export function workflowJob(name: string, jobId: string): WorkflowJob {
  const job = workflowDocument(name).jobs?.[jobId];
  if (!job) throw new Error(`${name} has no job ${jobId}`);
  return job;
}

/** The shell a step runs, read from its script when it invokes one. */
export function stepShell(name: string, jobId: string, stepName: string): string {
  const step = (workflowJob(name, jobId).steps ?? []).find((candidate) => candidate.name === stepName);
  if (!step) throw new Error(`${name}:${jobId} has no step named ${JSON.stringify(stepName)}`);
  if (step.uses === STEP_ACTION_REFERENCE) {
    const entryPath = step.with?.[STEP_ACTION_ENTRY_INPUT];
    if (isStepActionEntryPath(entryPath) && Object.keys(step.with ?? {}).length === 1) {
      throw new Error(`${name}:${jobId}:${stepName} runs a typed entry, not shell`);
    }
    const scriptPath = step.with?.[STEP_ACTION_SCRIPT_INPUT];
    if (!isStepActionScriptPath(scriptPath) || Object.keys(step.with ?? {}).length !== 1) {
      throw new Error(`${name}:${jobId}:${stepName} has an invalid typed action script`);
    }
    return readFileSync(fileURLToPath(new URL(scriptPath, repositoryRoot)), 'utf8');
  }
  if (typeof step.run !== 'string') throw new Error(`${name}:${jobId}:${stepName} runs no shell`);
  const invoked = /^bash (?:scripts\/ci\/lib\/run-step\.sh )?(scripts\/[^\s]+\.sh)$/.exec(step.run.trim());
  if (!invoked) return step.run;
  const scriptPath = invoked[1];
  if (scriptPath === undefined) throw new Error(`${name}:${jobId}:${stepName} has an invalid script path`);
  return readFileSync(fileURLToPath(new URL(scriptPath, repositoryRoot)), 'utf8');
}

/** A step's declared environment, without the annotation contract. */
export function stepEnvironment(
  name: string,
  jobId: string,
  stepName: string,
): Record<string, unknown> {
  const step = (workflowJob(name, jobId).steps ?? []).find((candidate) => candidate.name === stepName);
  if (!step) throw new Error(`${name}:${jobId} has no step named ${JSON.stringify(stepName)}`);
  return Object.fromEntries(
    Object.entries(step.env ?? {}).filter(([key]) => !key.startsWith('EXAMPLE_')),
  );
}

/**
 * A generated workflow's text in the spelling the hand-written files used.
 *
 * The emitter makes two formatting choices the hand-written YAML did not: it
 * quotes a scalar that is wholly a `${{ }}` expression (doubling the quotes
 * inside it), and it writes short sequences in block form rather than flow.
 * Neither changes what GitHub reads, but both break a regex written against
 * the old text — which is most of the assertions in scripts/tests.
 *
 * Normalising here keeps those assertions testing behaviour instead of
 * formatting, and keeps the fix in one place rather than in every regex.
 *
 * **The result is for matching, not parsing.** Unquoting an expression that
 * contains `:` produces text a YAML parser rejects, which is fine for a regex
 * and fatal for `yaml.load`. A test that parses the document should read the
 * file directly, or use `workflowDocument`/`workflowJob` above.
 *
 * @param {string} source raw workflow YAML
 * @returns {string}
 */
export function conventionalWorkflowText(source: string): string {
  const unquoted = source.replace(
    /^([^\S\n]*(?:- )?)([A-Za-z_][\w.-]*): '((?:[^']|'')*)'$/gm,
    (match: string, prefix: string, key: string, body: string): string => {
      const inner = String(body).replace(/''/g, "'");
      // An `if:` value is always an expression, and GitHub lets it omit the
      // `${{ }}`. The quotes around it are the dumper declining to fold a long
      // plain scalar across lines, never something the author wrote, so the
      // `${{` test above never reaches them.
      if (key !== 'if' && !inner.includes('${{')) {
        return match;
      }
      return `${prefix}${key}: ${inner}`;
    },
  );
  // `labels` and `needs` only. An earlier version reflowed any short list and
  // silently rewrote `on.pull_request.types`, which the hand-written files
  // kept in block form — an assertion looking for `- edited` on its own line
  // stopped matching and the normaliser became the bug. These two are the keys
  // those files wrote inline without exception (15 flow-form `needs`, zero
  // block), so they are the two restored.
  const conventional = unquoted.replace(
    /^(\s*)(labels|needs):\n((?:\1 {2}- [^\n:]+\n)+)/gm,
    (_match: string, indent: string, key: string, items: string): string => {
      const values = String(items).trim().split('\n').map((line) => line.replace(/^\s*-\s*/, '').trim());
      return `${indent}${key}: [${values.join(', ')}]\n`;
    },
  );
  // Legacy text assertions splice the wrapper's script into a job. Supply an
  // equivalent display-only run line for this generated local action; the
  // parsed workflow and migration proof still inspect its real `uses` input.
  const actionReference = STEP_ACTION_REFERENCE.replaceAll('.', '\\.');
  return conventional.replace(
    new RegExp(`^( {8}uses: ${actionReference}\\n)((?: {8,}[^\\n]*\\n)*?)( {10}${STEP_ACTION_SCRIPT_INPUT}: (scripts\\/[a-zA-Z0-9_./-]+\\.sh))$`, 'gm'),
    (match: string, action: string, body: string, scriptLine: string, script: string): string => {
      if (!isStepActionScriptPath(script)) return match;
      return `${action}${body}${scriptLine}\n        run: bash scripts/ci/lib/run-step.sh ${script}`;
    },
  );
}

/**
 * Returns the text of the named step from a conventional workflow document.
 *
 * The hand-written workflow shared steps between Mac lanes through a YAML
 * anchor, so a shared step appeared once. The emitter writes each lane's copy
 * out literally, so the same step now appears once per lane. Every copy must
 * still be identical — that is what the anchor guaranteed — so reading the
 * first copy is still reading the only definition.
 *
 * @param {string} workflowText Workflow text from conventionalWorkflowText.
 * @param {string} stepName The step's `name:` value.
 * @returns {string} The step's text, up to the next step.
 * @throws {Error} If the step is absent, or its copies are not identical.
 */
export function namedWorkflowStep(workflowText: string, stepName: string): string {
  const marker = `\n      - name: ${stepName}\n`;
  const copies = [];
  for (
    let start = workflowText.indexOf(marker);
    start !== -1;
    start = workflowText.indexOf(marker, start + marker.length)
  ) {
    const next = workflowText.indexOf('\n      - name:', start + marker.length);
    copies.push(workflowText.slice(start, next === -1 ? undefined : next));
  }
  if (copies.length === 0) {
    throw new Error(`missing workflow step: ${stepName}`);
  }
  const [firstCopy] = copies;
  if (firstCopy === undefined) {
    throw new Error(`missing workflow step: ${stepName}`);
  }
  for (const copy of copies.slice(1)) {
    if (copy !== firstCopy) {
      throw new Error(`workflow step differs between lanes: ${stepName}`);
    }
  }
  return firstCopy;
}
