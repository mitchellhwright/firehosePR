/** Native gcloud consumes references only; secret payloads never enter the flags file. */
export const requiredStagingSecrets = {
  ADMIN_USER_EMAILS: 'ADMIN_USER_EMAILS:2',
  IDENTITY_PLATFORM_API_KEY: 'IDENTITY_PLATFORM_SERVER_API_KEY:latest',
  AUTH_CODE_PEPPER: 'AUTH_CODE_PEPPER:latest', GROQ_API_KEY: 'GROQ_API_KEY:latest',
  OPENAI_API_KEY: 'OPENAI_API_KEY:latest', PLAID_ENV: 'PLAID_ENV:latest',
  PLAID_CLIENT_ID: 'PLAID_CLIENT_ID:latest', PLAID_SECRET: 'PLAID_SECRET:latest',
  BREVO_SMTP_USER: 'BREVO_SMTP_USER:latest', BREVO_SMTP_PASS: 'BREVO_SMTP_PASS:latest',
  BRAVE_SEARCH_API_KEY: 'BRAVE_SEARCH_API_KEY:latest', APNS_KEY_CONTENT: 'APNS_KEY_CONTENT:latest',
  APNS_KEY_ID: 'APNS_KEY_ID:latest', APNS_TEAM_ID: 'APNS_TEAM_ID:latest',
} as const;
export const optionalStagingSecretGroups = [
  { id: 'github-token', secrets: ['OBSERVABILITY_GITHUB_TOKEN'] },
  { id: 'github-app', secrets: ['OBSERVABILITY_GITHUB_APP_ID', 'OBSERVABILITY_GITHUB_APP_PRIVATE_KEY', 'OBSERVABILITY_GITHUB_INSTALLATION_ID'] },
  { id: 'apple-sign-in', secrets: ['APPLE_SIGN_IN_CLIENT_ID', 'APPLE_SIGN_IN_TEAM_ID', 'APPLE_SIGN_IN_KEY_ID', 'APPLE_SIGN_IN_PRIVATE_KEY', 'APPLE_TOKEN_ENCRYPTION_KEY_ID', 'APPLE_TOKEN_ENCRYPTION_KEYS'] },
  { id: 'app-store-server', secrets: ['APP_STORE_SERVER_PRIVATE_KEY', 'APP_STORE_SERVER_KEY_ID', 'APP_STORE_SERVER_ISSUER_ID'] },
] as const;
export type OptionalStagingSecret = (typeof optionalStagingSecretGroups)[number]['secrets'][number];
export interface StagingDeployInputs { readonly project: string; readonly commitSha: string; readonly buildId: string }
export interface StagingDeployFlags {
  readonly '--no-traffic': null;
  readonly '--revision-suffix': string;
  readonly '--set-secrets': Readonly<Record<string, string>>;
}
export function validateStagingDeployInputs(inputs: StagingDeployInputs): void {
  if (inputs.project !== 'example-app' || !/^[0-9a-f]{40}$/.test(inputs.commitSha)
    || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(inputs.buildId)) {
    throw new Error('Invalid staging deployment identity');
  }
}
export async function prepareStagingDeployFlags(inputs: StagingDeployInputs, runtime: {
  readonly accessible: (secret: OptionalStagingSecret) => Promise<boolean>;
  readonly log: (message: string) => void;
}): Promise<StagingDeployFlags> {
  validateStagingDeployInputs(inputs);
  const secrets = optionalStagingSecretGroups.flatMap(group => [...group.secrets]);
  const available = new Set<OptionalStagingSecret>();
  let next = 0;
  // Four bounded workers replace thirteen serial SDK startups. Each secret is probed once.
  await Promise.all(Array.from({ length: 4 }, async () => {
    while (next < secrets.length) {
      const secret = secrets[next++];
      if (secret === undefined) throw new Error('Invalid secret probe index');
      if (await runtime.accessible(secret)) available.add(secret);
    }
  }));
  const bindings: Record<string, string> = { ...requiredStagingSecrets };
  for (const group of optionalStagingSecretGroups) {
    const ready = group.secrets.every(secret => available.has(secret));
    if (ready) for (const secret of group.secrets) bindings[secret] = `${secret}:latest`;
    runtime.log(JSON.stringify({ event: 'staging-secret-group', group: group.id,
      decision: ready ? 'bind' : 'omit', reason: ready ? 'all-accessible' : 'optional-set-incomplete' }));
  }
  return { '--no-traffic': null,
    '--revision-suffix': `${inputs.commitSha.slice(0, 12)}-${inputs.buildId.slice(0, 8)}`,
    '--set-secrets': bindings };
}

/** Same access permission as gcloud secrets versions access, without consuming payloads. */
export async function probeStagingSecret(project: string, bearer: string, secret: OptionalStagingSecret,
  request: typeof fetch = fetch): Promise<boolean> {
  try {
    const response = await request(`https://secretmanager.googleapis.com/v1/projects/${project}/secrets/${secret}/versions/latest:access`, {
      headers: { Authorization: `Bearer ${bearer}` }, redirect: 'error', signal: AbortSignal.timeout(10_000),
    });
    await response.body?.cancel();
    return response.ok;
  } catch { return false; } // Inaccessible optional groups remain omitted, as before.
}
