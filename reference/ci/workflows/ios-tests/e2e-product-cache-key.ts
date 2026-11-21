import { concat, type ExpressionValue } from '../lib/index.ts';

const prefix = 'ios-e2e-test-products-v2-';

/** One producer cache per exact head and workflow run, shared by every job-only rerun. */
export function e2eProductCacheKey(
  headSha: ExpressionValue,
  runId: ExpressionValue,
): ExpressionValue {
  return concat(prefix, headSha, '-', runId);
}

/** Read existing attempt-scoped caches while transitioning to the stable key. */
export function legacyE2eProductCacheKey(
  headSha: ExpressionValue,
  runId: ExpressionValue,
  runAttempt: ExpressionValue,
): ExpressionValue {
  return concat(prefix, headSha, '-', runId, '-', runAttempt);
}
