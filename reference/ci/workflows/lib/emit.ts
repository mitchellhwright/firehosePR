import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { parsePinComments, pinYamlContent } from 'gagen';
import {
  CONSUMER_NAMES_MODULE, renderConsumerModule,
} from './consumerNames.ts';
import type { WorkflowDefinition } from './model.ts';
import { contractSourcesFrom } from './projections.ts';
import { stepActionSources } from './stepAction.ts';

/**
 * `.github/workflows/*.yml` are artifacts of the definitions under
 * `ci/workflows/`. Rendering is offline and deterministic: action tags
 * resolve through a committed lockfile rather than the network, so the same
 * definitions always produce the same bytes and `ci:check` can prove the
 * committed YAML is the one the definitions describe.
 */

export const GENERATED_HEADER = (source: string): string =>
  `# GENERATED from ${source} — edit the source, not this file.\n# Regenerate with: npm run ci:workflows`;

export const PINS_PATH = 'ci/workflows/action-pins.json';

/** `owner/repo@tag` → commit SHA, from the committed lockfile. */
export function loadPins(root = process.cwd()): Map<string, string> {
  const path = join(root, PINS_PATH);
  const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'));
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`${PINS_PATH} must be an object of "owner/repo@tag": "<40-hex sha>"`);
  }
  const pins = new Map<string, string>();
  for (const [reference, sha] of Object.entries(parsed)) {
    if (typeof sha !== 'string' || !/^[0-9a-f]{40}$/.test(sha)) {
      throw new Error(`${PINS_PATH}: ${reference} must map to a 40-hex commit SHA`);
    }
    pins.set(reference, sha);
  }
  return pins;
}

export function emitYaml(
  definition: WorkflowDefinition,
  options: { readonly pins: ReadonlyMap<string, string>; readonly existing?: string },
): string {
  let unpinned = definition.workflow.toYamlString({ header: GENERATED_HEADER(definition.config.source) });
  const queue = definition.config.concurrency?.queue;
  if (queue !== undefined) {
    // gagen 0.5.1 renders group and cancel-in-progress but does not expose the
    // newer GitHub queue field. Keep the value in the typed definition and add
    // exactly one root-level field to its deterministic generated artifact.
    const withQueue = unpinned.replace(
      /^(concurrency:\n {2}group: [^\n]*\n)/m,
      `$1  queue: ${queue}\n`,
    );
    if (withQueue === unpinned) throw new Error(`Cannot render concurrency queue for ${definition.config.path}`);
    unpinned = withQueue;
  }
  const { content } = pinYamlContent(
    unpinned,
    (owner, repo, ref) => {
      const sha = options.pins.get(`${owner}/${repo}@${ref}`);
      if (sha === undefined) {
        throw new Error(`Unpinned action ${owner}/${repo}@${ref}: run npm run workflows:pins`);
      }
      return sha;
    },
    parsePinComments(options.existing ?? ''),
  );
  return content.endsWith('\n') ? content : `${content}\n`;
}

export interface DriftReport {
  readonly path: string;
  readonly reason: 'missing' | 'differs';
  readonly diff: string;
}

/** The first differing lines, enough to see what changed without printing the file. */
function firstDifferences(expected: string, actual: string, limit = 20): string {
  const left = expected.split('\n');
  const right = actual.split('\n');
  const lines: string[] = [];
  for (let index = 0; index < Math.max(left.length, right.length); index += 1) {
    if (left[index] === right[index]) continue;
    if (right[index] !== undefined) lines.push(`-${index + 1}: ${right[index]}`);
    if (left[index] !== undefined) lines.push(`+${index + 1}: ${left[index]}`);
    if (lines.length >= limit) { lines.push('…'); break; }
  }
  return lines.join('\n');
}

/**
 * The generated files that are not workflows: compatibility contracts and
 * the names controllers import. They are checked with the YAML so a rename
 * cannot reach GitHub without reaching the programs that read it back.
 */
function generatedSources(definitions: readonly WorkflowDefinition[], root: string): Map<string, string> {
  return new Map([
    ...contractSourcesFrom(definitions),
    [CONSUMER_NAMES_MODULE, renderConsumerModule(definitions)],
    ...stepActionSources(root),
  ]);
}

export function checkDefinitions(definitions: readonly WorkflowDefinition[], root = process.cwd()): DriftReport[] {
  const pins = loadPins(root);
  const reports: DriftReport[] = [];
  for (const [relative, expected] of generatedSources(definitions, root)) {
    const path = join(root, relative);
    if (!existsSync(path)) {
      reports.push({ path: relative, reason: 'missing', diff: '' });
      continue;
    }
    const existing = readFileSync(path, 'utf8');
    if (expected !== existing) {
      reports.push({ path: relative, reason: 'differs', diff: firstDifferences(expected, existing) });
    }
  }
  for (const definition of definitions) {
    const path = join(root, definition.config.path);
    if (!existsSync(path)) {
      reports.push({ path: definition.config.path, reason: 'missing', diff: '' });
      continue;
    }
    const existing = readFileSync(path, 'utf8');
    const expected = emitYaml(definition, { pins, existing });
    if (expected !== existing) {
      reports.push({ path: definition.config.path, reason: 'differs', diff: firstDifferences(expected, existing) });
    }
  }
  return reports;
}

export function writeDefinitions(definitions: readonly WorkflowDefinition[], root = process.cwd()): string[] {
  const pins = loadPins(root);
  const written: string[] = [];
  for (const [relative, content] of generatedSources(definitions, root)) {
    const path = join(root, relative);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, content);
    written.push(relative);
  }
  for (const definition of definitions) {
    const path = join(root, definition.config.path);
    const existing = existsSync(path) ? readFileSync(path, 'utf8') : undefined;
    writeFileSync(path, emitYaml(definition, { pins, ...(existing === undefined ? {} : { existing }) }));
    written.push(definition.config.path);
  }
  return written;
}
