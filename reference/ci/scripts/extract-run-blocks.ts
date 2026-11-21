import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { load } from 'js-yaml';
import { z } from 'zod';
import { failureOwnerSchema, statusUnitSchema, uiSemanticCategorySchema, workflowContractRegistry } from '../src/workflowContract.ts';

/**
 * Migration tool, deleted once every workflow is defined in TypeScript.
 *
 * It moves each multi-line `run` block of a hand-written workflow into
 * `scripts/ci/<workflow>/<job>/<step>.sh` without changing a byte of the
 * shell, and prints a `typedStep` skeleton per step with everything the YAML
 * already said carried over. What it cannot know — the step's purpose,
 * failure owner and recovery sentence — it fills from the current registry
 * entry for that position, and marks `TODO` where the registry has nothing,
 * so the definition is completed by hand only where a human judgement is
 * actually needed.
 */

const stepSchema = z.object({
  name: z.string().optional(),
  id: z.string().optional(),
  if: z.union([z.string(), z.boolean()]).optional(),
  uses: z.string().optional(),
  run: z.string().optional(),
  with: z.record(z.string(), z.unknown()).optional(),
  env: z.record(z.string(), z.unknown()).optional(),
  shell: z.string().optional(),
  'working-directory': z.string().optional(),
  'continue-on-error': z.union([z.boolean(), z.string()]).optional(),
  'timeout-minutes': z.number().optional(),
}).passthrough();

const documentSchema = z.object({
  jobs: z.record(z.string(), z.object({ steps: z.array(stepSchema).optional() }).passthrough()),
}).passthrough();

/**
 * The expanded registry derives its UI text from the semantic category and
 * then drops the category itself, so the category, owner and unit come from
 * the compact contract the registry is built from.
 */
const compactContractSchema = z.object({
  workflows: z.array(z.object({
    path: z.string(),
    jobs: z.array(z.object({
      id: z.string(),
      steps: z.array(z.object({
        displayName: z.string(),
        semanticCategory: uiSemanticCategorySchema,
        failureOwner: failureOwnerSchema,
        statusUnit: statusUnitSchema,
      }).passthrough()),
    }).passthrough()),
  }).passthrough()),
}).passthrough();

type CompactContract = z.infer<typeof compactContractSchema>;

/** The compact contract, or nothing when this tree has none (a fixture root). */
function loadCompactContract(root: string): CompactContract | undefined {
  const path = join(root, 'ci/contracts/workflow-ui-contract.v2.json');
  if (!existsSync(path)) return undefined;
  return compactContractSchema.parse(JSON.parse(readFileSync(path, 'utf8')));
}

export interface ExtractedStep {
  readonly jobId: string;
  readonly position: number;
  readonly scriptPath?: string;
  readonly skeleton: string;
}

const slug = (text: string): string => text.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');

/** A TypeScript string literal, single-quoted like the rest of the definitions. */
function quote(value: string): string {
  return `'${value.replace(/\\/g, '\\\\').replace(/'/g, "\\'").replace(/\n/g, '\\n')}'`;
}

export function extractRunBlocks(workflowPath: string, root = process.cwd()): ExtractedStep[] {
  const workflowName = workflowPath.replace(/^\.github\/workflows\//, '').replace(/\.ya?ml$/, '');
  const document = documentSchema.parse(load(readFileSync(join(root, workflowPath), 'utf8')));
  const contract = workflowContractRegistry.workflows.find((workflow) => workflow.path === workflowPath);
  const compactContract = loadCompactContract(root)?.workflows.find((workflow) => workflow.path === workflowPath);
  const extracted: ExtractedStep[] = [];

  for (const [jobId, job] of Object.entries(document.jobs)) {
    const contractSteps = contract?.jobs.find((candidate) => candidate.id === jobId)?.steps ?? [];
    const compact = compactContract?.jobs.find((candidate) => candidate.id === jobId)?.steps ?? [];
    (job.steps ?? []).forEach((step, index) => {
      const position = index + 1;
      const entry = contractSteps[index];
      const displayName = step.name ?? `TODO name step ${position}`;
      const recovery = entry?.nextAction?.replace(/^[A-Za-z]+ owner: for .*?, /, '').replace(/\.$/, '')
        ?? 'TODO recovery sentence';

      const fields: string[] = [`name: ${quote(displayName)}`];
      if (step.id !== undefined) fields.push(`id: ${quote(step.id)}`);
      fields.push(`doc: { purpose: ${quote(entry?.purpose ?? 'TODO one sentence on what this step does')}, recovery: ${quote(recovery)} }`);
      const semantics = compact[index];
      fields.push(`owner: ${quote(semantics?.failureOwner ?? entry?.failureOwner ?? 'TODO')}`);
      fields.push(`category: ${quote(semantics?.semanticCategory ?? 'TODO')}`);
      fields.push(`unit: ${quote(semantics?.statusUnit ?? 'step')}`);

      let scriptPath: string | undefined;
      if (step.uses !== undefined) {
        fields.push(`uses: ${quote(step.uses)}`);
      } else if (step.run !== undefined && step.run.trimEnd().includes('\n')) {
        scriptPath = `scripts/ci/${workflowName}/${jobId}/${step.name === undefined ? `step-${position}` : slug(step.name)}.sh`;
        const lines = step.run.trimEnd().split('\n');
        const body = lines[0]?.trim() === 'set -euo pipefail' ? lines.slice(1) : lines;
        mkdirSync(dirname(join(root, scriptPath)), { recursive: true });
        writeFileSync(join(root, scriptPath), `#!/usr/bin/env bash\nset -euo pipefail\n${body.join('\n')}\n`);
        fields.push(`script: ${quote(scriptPath)}`);
      } else if (step.run !== undefined) {
        fields.push(`command: ${quote(step.run.trim())}`);
      }

      if (step.with !== undefined) fields.push(`with: ${JSON.stringify(step.with)}`);
      if (step.env !== undefined) {
        const entries = Object.entries(step.env).map(([key, value]) => `${key}: ${quote(String(value))}`);
        fields.push(`env: { ${entries.join(', ')} }`);
      }
      if (step.if !== undefined) fields.push(`if: ${quote(String(step.if).trim())}`);
      if (step.shell !== undefined) fields.push(`shell: ${quote(step.shell)}`);
      if (step['working-directory'] !== undefined) fields.push(`workingDirectory: ${quote(step['working-directory'])}`);
      if (step['continue-on-error'] !== undefined) fields.push(`continueOnError: ${JSON.stringify(step['continue-on-error'])}`);
      if (step['timeout-minutes'] !== undefined) fields.push(`timeoutMinutes: ${step['timeout-minutes']}`);

      extracted.push({
        jobId,
        position,
        ...(scriptPath === undefined ? {} : { scriptPath }),
        skeleton: `typedStep({ ${fields.join(', ')} })`,
      });
    });
  }
  return extracted;
}

if (process.argv[1]?.endsWith('extract-run-blocks.ts')) {
  const path = process.argv[2];
  if (path === undefined) {
    console.error('usage: extract-run-blocks.ts .github/workflows/<name>.yml');
    process.exit(2);
  }
  let lastJob = '';
  for (const step of extractRunBlocks(path)) {
    if (step.jobId !== lastJob) {
      console.log(`\n// ===== job ${step.jobId}`);
      lastJob = step.jobId;
    }
    console.log(`${step.skeleton},`);
  }
}
