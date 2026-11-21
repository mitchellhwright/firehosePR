import { fileURLToPath } from 'node:url';
import { error, fail, pass, runStepProgram, type StepDecision } from '../ios/shared/stepDecision.ts';

const credentialNames = [
  'APP_STORE_CONNECT_API_KEY_ID',
  'APP_STORE_CONNECT_API_KEY_ISSUER_ID',
  'APP_STORE_CONNECT_API_KEY_CONTENT',
] as const;

export function validateAppStoreConnectConfiguration(
  environment: NodeJS.ProcessEnv,
): StepDecision {
  const missing = credentialNames.filter((name) => !environment[name]);
  return missing.length > 0
    ? fail(error(`Missing App Store Connect secrets: ${missing.join(' ')}`))
    : pass();
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  runStepProgram('App Store Connect configuration', () =>
    validateAppStoreConnectConfiguration(process.env));
}
