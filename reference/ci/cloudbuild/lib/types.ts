/** Deliberately scoped to the Cloud Build fields owned by this repository. */
export interface CloudBuildStep<Id extends string> {
  readonly name: string;
  readonly id: Id;
  readonly waitFor?: readonly Id[] | readonly ['-'];
  readonly entrypoint?: string;
  readonly args?: readonly string[];
  readonly env?: readonly `${string}=${string}`[];
  readonly secretEnv?: readonly string[];
  readonly timeout?: `${number}s`;
  readonly allowFailure?: boolean;
}

export interface CloudBuild<Id extends string> {
  readonly steps: readonly CloudBuildStep<Id>[];
  readonly images: readonly string[];
  readonly timeout?: `${number}s`;
  readonly options: {
    readonly machineType?: 'E2_HIGHCPU_8' | 'E2_HIGHCPU_32' | 'E2_MEDIUM';
    readonly logging: 'CLOUD_LOGGING_ONLY' | 'GCS_ONLY' | 'LEGACY' | 'NONE';
  };
  readonly availableSecrets?: {
    readonly secretManager: readonly { readonly versionName: string; readonly env: string }[];
  };
  readonly substitutions: Readonly<Record<`_${string}`, string>>;
}

/** Cloud Build dependencies must reference earlier steps; omission waits for all earlier steps. */
export function validateCloudBuild<Id extends string>(build: CloudBuild<Id>): void {
  if (build.steps.length === 0) throw new Error('Cloud Build requires at least one step');
  const secrets = new Set<string>();
  for (const secret of build.availableSecrets?.secretManager ?? []) {
    if (secrets.has(secret.env)) throw new Error(`Duplicate secret environment: ${secret.env}`);
    secrets.add(secret.env);
  }
  const seen = new Set<string>();
  for (const step of build.steps) {
    if (!step.id || step.id === '-' || seen.has(step.id))
      throw new Error(`Invalid or duplicate step ID: ${step.id}`);
    const dependencies: readonly string[] = step.waitFor ?? [];
    if (dependencies.includes('-') && dependencies.length !== 1) {
      throw new Error(`Step ${step.id} mixes the start marker with dependencies`);
    }
    for (const dependency of step.waitFor ?? []) {
      if (dependency !== '-' && !seen.has(dependency)) {
        throw new Error(`Step ${step.id} depends on an unknown or later step: ${dependency}`);
      }
    }
    for (const secret of step.secretEnv ?? []) {
      if (!secrets.has(secret))
        throw new Error(`Step ${step.id} uses undeclared secret: ${secret}`);
    }
    seen.add(step.id);
  }
}
