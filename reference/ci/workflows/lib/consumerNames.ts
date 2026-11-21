import { nameMatcher, type NameMatcher } from './names.ts';
import type { WorkflowDefinition } from './model.ts';

/**
 * The names the definitions publish to everything that reads them back off the
 * GitHub API.
 *
 * A workflow name and a job name are interfaces, not presentation: the
 * controllers under `scripts/` branch on them, and a rename that reaches
 * `.github/workflows` without reaching those controllers is a silent outage —
 * the controller simply stops recognising the job and does nothing. Typing the
 * definitions did not fix that on its own, because the consumers are separate
 * programs that never imported anything from here.
 *
 * So the names are generated into a strict TypeScript module those consumers
 * import. A renamed job regenerates the module; a consumer that asks for a job
 * id that no longer exists fails `npm run ci:typecheck:scripts`; and a consumer
 * that spells a name out by hand fails
 * `ci/tests/workflows.consumerNames.test.ts`.
 */

export const CONSUMER_NAMES_MODULE = 'scripts/ci/generated/workflow-names.ts';

const HEADER = [
  '// GENERATED from ci/workflows — edit the definitions, not this file.',
  '// Regenerate with: npm run ci:workflows',
  '',
].join('\n');

export interface PublishedWorkflowNames {
  readonly workflow: string;
  readonly jobs: Readonly<Record<string, NameMatcher>>;
}

export function workflowSlug(path: string): string {
  return path.replace(/^\.github\/workflows\//, '').replace(/\.ya?ml$/, '');
}

export function consumerNames(
  definitions: readonly WorkflowDefinition[],
): ReadonlyMap<string, PublishedWorkflowNames> {
  const published = new Map<string, PublishedWorkflowNames>();
  for (const definition of definitions) {
    const jobs: Record<string, NameMatcher> = {};
    for (const job of definition.config.jobs) {
      jobs[job.id] = nameMatcher(job.config.name, job.config.retiredNamePatterns);
    }
    published.set(workflowSlug(definition.config.path), { workflow: definition.config.name, jobs });
  }
  return published;
}

function quote(value: string): string {
  return JSON.stringify(value);
}

function matcherLiteral(matcher: NameMatcher, indent: string): string {
  const literals = matcher.literals.map(quote).join(', ');
  return [
    'Object.freeze({',
    `${indent}  name: ${quote(matcher.name)},`,
    `${indent}  literals: Object.freeze([${literals}]),`,
    `${indent}  pattern: ${quote(matcher.pattern)},`,
    `${indent}  suffixed: ${String(matcher.suffixed)},`,
    `${indent}})`,
  ].join('\n');
}

export function renderConsumerModule(definitions: readonly WorkflowDefinition[]): string {
  const lines = [
    HEADER,
    'export interface PublishedName {',
    '  readonly name: string;',
    '  readonly literals: readonly string[];',
    '  readonly pattern: string;',
    '  readonly suffixed: boolean;',
    '}',
    '',
    '/** Every workflow and job name the typed definitions render. */',
    'export const workflowNames = Object.freeze({',
  ];
  for (const [slug, entry] of consumerNames(definitions)) {
    lines.push(`  ${quote(slug)}: Object.freeze({`);
    lines.push(`    workflow: ${quote(entry.workflow)},`);
    lines.push('    jobs: Object.freeze({');
    for (const [id, matcher] of Object.entries(entry.jobs)) {
      lines.push(`      ${quote(id)}: ${matcherLiteral(matcher, '      ')},`);
    }
    lines.push('    }),');
    lines.push('  }),');
  }
  lines.push('} as const);');
  lines.push('');
  lines.push(...[
    '/**',
    ' * The compiled matcher for a published name. Consumers match with this',
    ' * rather than rebuilding a pattern from the literal, because a name\'s shape',
    ' * — a parenthesised suffix, an alternation, a spelling still in flight on an',
    ' * open pull request — is part of what the definition decides.',
    ' *',
    ' */',
    'export function nameRegExp(matcher: Pick<PublishedName, \'pattern\'>): RegExp {',
    '  return new RegExp(matcher.pattern);',
    '}',
    '',
  ]);
  return lines.join('\n');
}
