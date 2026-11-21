import {
  devGcpRuntimeConfig,
  devGcpRuntimeSecrets,
} from '../../ios/realServerE2eLanes.ts';
import { exportStepEnvBlock } from '../../ios/shared/actionIo.ts';
import { appendGithubEnvBlock, maskSecret } from '../../ios/shared/githubStepIo.ts';
import { runCommand } from '../../ios/shared/processRunner.ts';
import { StepFailure } from '../../ios/shared/stepFailure.ts';
import { runStep } from '../../ios/shared/stepIo.ts';

/**
 * Publishes the development runtime configuration the lane's backend needs.
 *
 * The two Secret Manager values are masked before they are exported, and
 * exported in the delimiter form: a bare `NAME=value` line would let a newline
 * inside a secret forge a second environment entry.
 */

/** `$(gcloud …)` dropped every trailing newline; a secret is compared verbatim. */
function withoutTrailingNewlines(value: string): string {
  return value.replace(/\n+$/, '');
}

async function readSecret(secretName: string): Promise<string> {
  const accessed = await runCommand(
    'gcloud',
    ['secrets', 'versions', 'access', 'latest', '--project=example-app', `--secret=${secretName}`],
    { capture: true },
  );
  if (accessed.status !== 0) {
    throw new StepFailure(accessed.stderr.trim(), 'stderr', accessed.status);
  }
  return withoutTrailingNewlines(accessed.stdout);
}

async function run(): Promise<void> {
  const secrets = new Map<string, string>();
  for (const [secretName, variableName] of devGcpRuntimeSecrets) {
    const value = await readSecret(secretName);
    maskSecret(value);
    secrets.set(variableName, value);
  }
  exportStepEnvBlock(devGcpRuntimeConfig());
  for (const [variableName, value] of secrets) appendGithubEnvBlock(variableName, value);
}

await runStep('Load dev GCP runtime config', run);
