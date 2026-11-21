import { expr, type ExpressionValue } from 'gagen';
import type { TypedJob } from './model.ts';

export { concat, conditions, defineMatrix, expr, fromJSON, toJSON } from 'gagen';
export type { ExpressionValue } from 'gagen';

/** `${{ vars.NAME }}` */
export const vars = (name: string): ExpressionValue => expr(`vars.${name}`);
/** `${{ secrets.NAME }}` */
export const secret = (name: string): ExpressionValue => expr(`secrets.${name}`);
/** `${{ inputs.name }}` */
export const inputs = (name: string): ExpressionValue => expr(`inputs.${name}`);
/** `${{ github.<path> }}` */
export const github = (path: string): ExpressionValue => expr(`github.${path}`);
/** `${{ runner.<path> }}` */
export const runner = (path: string): ExpressionValue => expr(`runner.${path}`);
/** `${{ needs.<job>.outputs.<name> }}` from a producer with a declared output. */
export const needsOutput = <const J extends TypedJob<string, never>>(
  producer: J, output: Extract<keyof J['outputs'], string>,
): ExpressionValue => expr(`needs.${producer.id}.outputs.${output}`);

/**
 * The repository's runs-on idiom: a repository variable naming the label set,
 * with a literal fallback so a missing variable cannot leave a job unroutable.
 */
export const runnerLabels = (variable: string, fallback: readonly string[]): ExpressionValue =>
  expr(`fromJson(vars.${variable} || '${JSON.stringify(fallback)}')`);
