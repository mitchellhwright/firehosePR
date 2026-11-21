import { z } from 'zod';

/**
 * Reading `needs.<job>.result` and the trusted-surface tests the iOS status
 * aggregates share.
 *
 * GitHub renders a `needs.<job>.result` (and every `needs.<job>.outputs.<key>`)
 * into the step's `env:` as a string that is empty when the need never ran or
 * never wrote the output. The replaced shell relied on exactly that: it
 * compared the bare variable and only reached for `${VAR:-default}` where an
 * empty value had to read as something else. These helpers keep both spellings
 * explicit instead of scattering `|| ''` through the decision modules.
 */

/** An env value GitHub always renders, possibly as the empty string. */
export const renderedEnvironmentValue = z.string().default('');

/** `${VAR:-missing}` — how the replaced shell named an absent result in a message. */
export function orMissing(result: string): string {
  return result.length === 0 ? 'missing' : result;
}

/** `${VAR:-fallback}` — an absent value standing in for a concrete default. */
export function orDefault(value: string, fallback: string): string {
  return value.length === 0 ? fallback : value;
}

/** `[ "$VAR" = "true" ]` over a value GitHub rendered from a boolean expression. */
export function isTrue(value: string): boolean {
  return value === 'true';
}

/** The two refs a privileged dispatch may run from. */
export const trustedDispatchRefs = ['refs/heads/develop', 'refs/heads/main'] as const;

export function isTrustedDispatchRef(ref: string): boolean {
  return (trustedDispatchRefs as readonly string[]).includes(ref);
}

/** The two base branches a same-repository pull request may target. */
export const trustedBaseBranches = ['develop', 'main'] as const;

export interface PullRequestSurface {
  readonly headRepository: string;
  readonly repository: string;
  readonly baseBranch: string;
}

/**
 * True only for a pull request whose head lives in this repository and whose
 * base is develop or main. A fork head or any other base is untrusted: the
 * privileged lanes never run for it, so the aggregates must not read a
 * non-skipped result from one as success.
 */
export function isTrustedPullRequestSurface(surface: PullRequestSurface): boolean {
  return (
    surface.headRepository === surface.repository &&
    (trustedBaseBranches as readonly string[]).includes(surface.baseBranch)
  );
}
