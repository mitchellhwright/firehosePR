import { concat, expr, type ExpressionValue } from 'gagen';
import { humanReadableNameSchema, requiredContextNameSchema } from '../../src/workflowContract.ts';

/**
 * A job or step name is one of three shapes, and nothing else can put an
 * expression into a name: a literal; a literal with one parenthesised suffix
 * rendered from an expression (a matrix shard, a host label, a PR number); or
 * a choice between literals keyed on the event name, which is how a manual
 * run avoids producing the required-check context a pull request run does.
 *
 * Every shape has a finite set of literals. That is what makes a rendered
 * name resolvable: the projections key on those literals, so a controller
 * reading "Server tests (1/4)" from the API finds the same step the
 * definition declares, and readability is validated on each of them.
 */
export type NameSpec =
  | string
  | {
    readonly literal: string;
    readonly suffix: ExpressionValue;
    /** An annotation after the suffix, usually empty; see `suffixed`. */
    readonly trailer?: ExpressionValue;
  }
  | { readonly byEvent: Readonly<{ workflow_dispatch: string }>; readonly otherwise: string };

/** `<literal> (<matrix value>)`, e.g. `Server tests (1/4)`. */
export function matrixSuffixed(literal: string, matrixKey: string): NameSpec {
  return { literal, suffix: expr(`matrix.${matrixKey}`) };
}

/**
 * `<literal> (<expression>)`, e.g. `Install runner cleanup hook (host-instaip2)`.
 *
 * `trailer` appends one more expression after the closing parenthesis, for the
 * name a consumer parses rather than reads: the retained-predecessor marker
 * carries `(<run id> at <sha>)` always and ` [ancestors: …]` only when the
 * chain is longer than one run, and `resumeRetainedIosPredecessor.ts`
 * reads both halves back off the API. The literal head is unchanged, so the
 * name still resolves to this step.
 */
export function suffixed(literal: string, suffix: ExpressionValue, trailer?: ExpressionValue): NameSpec {
  return trailer === undefined ? { literal, suffix } : { literal, suffix, trailer };
}

/**
 * A different literal per triggering event. The fallback is the name the
 * required-check context uses, so an event listed here never satisfies a
 * required check by accident.
 */
export function byEvent(names: Readonly<{ workflow_dispatch: string }>, otherwise: string): NameSpec {
  return { byEvent: names, otherwise };
}

/** What gagen receives, and therefore what GitHub renders. */
export function renderName(name: NameSpec): string | ExpressionValue {
  if (typeof name === 'string') return name;
  if ('suffix' in name) {
    return name.trailer === undefined
      ? concat(`${name.literal} (`, name.suffix, ')')
      : concat(`${name.literal} (`, name.suffix, ')', name.trailer);
  }
  const clauses = Object.entries(name.byEvent)
    .map(([event, literal]) => `github.event_name == '${event}' && '${literal}'`);
  return expr(`${clauses.join(' || ')} || '${name.otherwise}'`);
}

/**
 * Every literal GitHub can show for this name, the required-check form first.
 * A suffixed name contributes its literal alone: the suffix is data, and
 * `jobLiteralName` strips it back off a rendered name.
 */
export function renderedLiterals(name: NameSpec): readonly string[] {
  if (typeof name === 'string') return [name];
  if ('suffix' in name) return [name.literal];
  return [name.otherwise, ...Object.values(name.byEvent)];
}

/**
 * What a consumer needs to recognise this job in an API response.
 *
 * A controller reading `jobs.list` does not get the NameSpec, it gets a
 * string — and the string's *shape* is as much a part of the interface as its
 * words. `Capture Dependabot base edit PR 42` and
 * `Capture a Dependabot base edit (42)` name the same job, and a consumer that
 * re-derives the second from the first by hand is one rename away from
 * silently matching nothing. So the pattern is generated from the same
 * NameSpec that renders the name, and `retiredNamePatterns` carries the
 * spellings still in flight on open pull requests until their runs age out.
 */
export interface NameMatcher {
  /** The literal a required check lists, and the name to print. */
  readonly name: string;
  /** Every literal GitHub can render for this job today. */
  readonly literals: readonly string[];
  /** Anchored regular expression source; a suffixed name captures `suffix`. */
  readonly pattern: string;
  /** Whether a rendered name carries a parenthesised suffix after the literal. */
  readonly suffixed: boolean;
}

function escapeForRegExp(literal: string): string {
  return literal.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * `retiredNamePatterns` are unanchored regular-expression alternatives for
 * names this job no longer renders but can still be reported under by a run
 * that started before the rename merged. Each one is dead weight the day the
 * last such run ages out, and the definition that declares it says when that
 * is: deleting it is a one-line change here rather than a sweep of consumers.
 */
export function nameMatcher(name: NameSpec, retiredNamePatterns: readonly string[] = []): NameMatcher {
  const literals = renderedLiterals(name);
  const suffixed = typeof name === 'object' && 'suffix' in name;
  const alternation = literals.map(escapeForRegExp).join('|');
  const body = literals.length === 1 ? alternation : `(?:${alternation})`;
  // A trailer renders after the closing parenthesis, so the pattern has to
  // admit whatever follows it; the greedy suffix group still stops at the last
  // parenthesis the name renders.
  const trailer = typeof name === 'object' && 'suffix' in name && name.trailer !== undefined ? '.*' : '';
  const current = suffixed ? `${body} \\((?<suffix>.*)\\)${trailer}` : body;
  const alternatives = [current, ...retiredNamePatterns];
  return {
    name: literals[0] ?? '',
    literals,
    pattern: alternatives.length === 1 ? `^${current}$` : `^(?:${alternatives.join('|')})$`,
    suffixed,
  };
}

/** The literal part of a rendered job name: one trailing parenthesised group removed. */
export function jobLiteralName(rendered: string): string {
  return rendered.replace(/ \([^()]*\)$/, '');
}

/**
 * The literal head of a retired name pattern, up to its first metacharacter:
 * `Capture Dependabot base edit PR (?<suffix>[0-9]+)` → `Capture Dependabot
 * base edit PR`. Enough to find what still matches on it.
 */
export function retiredLiteralPrefix(pattern: string): string {
  const metacharacter = pattern.search(/[\\([.*+?^${|]/);
  return (metacharacter === -1 ? pattern : pattern.slice(0, metacharacter)).trim();
}

/**
 * Every spelling a consumer of this job still has to recognise: the literals
 * GitHub renders today, then the literal head of each retired pattern. A
 * program that matches on a name is complete when it covers all of them.
 */
export function recognisedNames(
  name: NameSpec,
  retiredNamePatterns: readonly string[] = [],
): readonly string[] {
  return [
    ...renderedLiterals(name),
    ...retiredNamePatterns.map(retiredLiteralPrefix).filter((prefix) => prefix !== ''),
  ];
}

/**
 * Readability issues, empty when every literal reads as a name a person can
 * act on.
 *
 * `requiredCheckContext` names the one literal a branch ruleset already lists,
 * which is held to the same rule except that it may be a generic name: the
 * ruleset spells it out, so renaming it stops the gate. Only `typedWorkflow`
 * can establish that a job really is declared required under that name, so
 * nothing here accepts a literal merely because it has the shape of one.
 */
export function validateName(name: NameSpec, requiredCheckContext?: string): string[] {
  const issues: string[] = [];
  for (const literal of renderedLiterals(name)) {
    const schema = literal === requiredCheckContext ? requiredContextNameSchema : humanReadableNameSchema;
    const result = schema.safeParse(literal);
    if (result.success) continue;
    for (const issue of result.error.issues) issues.push(`${JSON.stringify(literal)}: ${issue.message}`);
  }
  return issues;
}
