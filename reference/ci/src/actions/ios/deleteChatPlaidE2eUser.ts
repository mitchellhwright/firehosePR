import { z } from 'zod';

import {
  chatPlaidCleanupAttemptMessage,
  chatPlaidCleanupAttempts,
  chatPlaidCleanupEndpoint,
  chatPlaidCleanupFailedMessage,
  chatPlaidCleanupHeaders,
  chatPlaidCleanupSkippedMessage,
} from '../../ios/chatPlaidLane.ts';
import { deletionVerified } from '../../ios/developmentUserCleanup.ts';
import { errorAnnotation, log } from '../../ios/shared/githubStepIo.ts';
import { fetchJson, queryUrl } from '../../ios/shared/httpJson.ts';
import { readStepEnvironment } from '../../ios/shared/stepEnvironment.ts';
import { runStep } from '../../ios/shared/stepIo.ts';

/**
 * Deletes the synthetic identity the Chat Plaid lane linked a Plaid Sandbox
 * institution to.
 *
 * The delete is only complete when the backend re-reads the account and finds
 * it gone, so the response is checked with the same predicate the other lanes
 * use. A lane that never prepared an identity has nothing to clean up; a lane
 * that prepared one and could not delete it fails, because a retained account
 * would be relinked by the next run.
 */

const environmentSchema = z.object({
  ONBOARDING_DEV_BACKEND_PORT: z.string().regex(/^\d+$/, 'must be a port number'),
});

/** The per-request deadline the shell gave curl. */
const requestTimeoutMs = 60_000;

await runStep('Chat Plaid E2E user cleanup', async () => {
  const environment = readStepEnvironment(environmentSchema);
  const email = process.env.CHAT_PLAID_E2E_EMAIL ?? '';
  if (email.length === 0) {
    log(chatPlaidCleanupSkippedMessage);
    return;
  }

  const url = queryUrl(
    chatPlaidCleanupEndpoint(environment.ONBOARDING_DEV_BACKEND_PORT),
    [['email', email]],
  );
  const headers = chatPlaidCleanupHeaders(process.env);

  for (let attempt = 1; attempt <= chatPlaidCleanupAttempts; attempt += 1) {
    try {
      const payload = await fetchJson({ url, method: 'DELETE', timeoutMs: requestTimeoutMs, headers });
      if (deletionVerified(payload)) return;
    } catch {
      // A transport failure is the same as an unverified delete here: the
      // shell's `curl -f | python3` pipeline reported both as a failed attempt.
    }
    process.stdout.write(`::warning::${chatPlaidCleanupAttemptMessage(attempt)}\n`);
  }

  errorAnnotation(chatPlaidCleanupFailedMessage);
  process.exitCode = 1;
});
