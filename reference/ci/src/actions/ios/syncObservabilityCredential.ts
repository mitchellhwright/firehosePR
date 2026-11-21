import { requiredEnv } from '../../ios/shared/actionIo.ts';
import {
  secretVersionFailure,
  secretVersionRequest,
} from '../../ios/observabilityCredentialSync.ts';
import {
  error,
  fail,
  info,
  pass,
  runAsyncStepProgram,
} from '../../ios/shared/stepDecision.ts';

/**
 * "Add the current credential version": publishes the observability
 * dashboard's GitHub credential as a new Secret Manager version.
 *
 * The request is built by `ci/src/ios/observabilityCredentialSync.ts` and
 * performed here. Nothing is spawned: the replaced `curl` took the base64
 * credential as a command-line argument, which put it where every other
 * process on the runner could read it, and building the JSON body in shell
 * meant a single unexpected byte in the credential would have produced an
 * invalid request rather than a refused one.
 */
await runAsyncStepProgram('Observability credential sync', async () => {
  const request = secretVersionRequest({
    project: requiredEnv('GCP_PROJECT'),
    secret: requiredEnv('SECRET_NAME'),
    payload: requiredEnv('OBSERVABILITY_GITHUB_TOKEN'),
    accessToken: requiredEnv('GCP_ACCESS_TOKEN'),
  });
  const response = await fetch(request.url, {
    method: request.method,
    headers: request.headers,
    body: request.body,
  });
  const failure = secretVersionFailure(response.status, await response.text());
  if (failure !== null) return fail(error(failure));
  return pass(info('Published a new observability GitHub credential version.'));
});
