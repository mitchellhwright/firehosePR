import { existsSync } from 'node:fs';
import { join } from 'node:path';

import { requiredEnv } from '../../ios/shared/actionIo.ts';
import { appendStepOutputs } from '../../ios/shared/githubOutputs.ts';
import { notice, pass, runStepProgram } from '../../ios/shared/stepDecision.ts';
import {
  requiredSchemaVerifierScripts,
  schemaRevisionVerifierAvailability,
} from '../../ios/devE2eSchemaVerification.ts';

/**
 * "Check trusted schema-revision verifier availability".
 *
 * The revision verifier lands through the same pull request that first uses
 * it, so the trusted base checkout has no such script until that merges. The
 * two steps that need it are skipped rather than failed, and this writes the
 * output they branch on.
 */
runStepProgram('Schema revision verifier availability', () => {
  const checkout = join(requiredEnv('GITHUB_WORKSPACE'), requiredEnv('TRUSTED_CHECKOUT_PATH'));
  const availability = schemaRevisionVerifierAvailability(
    requiredSchemaVerifierScripts.map((script) => existsSync(join(checkout, script))),
  );
  appendStepOutputs([['available', availability.available]]);
  return pass(...availability.messages.map(notice));
});
