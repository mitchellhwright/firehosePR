import { z } from 'zod';

/**
 * Reading a step's environment at the boundary.
 *
 * A converted step is handed its inputs the same way the shell was: through
 * the process environment. Parsing them once with a zod schema is what makes
 * everything after it typed, and the only thing worth adding on top is the
 * failure message — a raw `ZodError` in an Actions log is a JSON blob that
 * does not say which variable the step was missing.
 */
export function readStepEnvironment<T>(
  schema: z.ZodType<T>,
  environment: NodeJS.ProcessEnv = process.env,
): T {
  const parsed = schema.safeParse(environment);
  if (parsed.success) return parsed.data;
  const reported = parsed.error.issues
    .map((issue) => `${issue.path.join('.') || '(environment)'}: ${issue.message}`)
    .join('; ');
  throw new Error(`Step environment is not usable: ${reported}`);
}
