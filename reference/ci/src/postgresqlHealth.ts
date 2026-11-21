export type ContainerHealth = 'starting' | 'healthy' | 'unhealthy';

export interface ContainerState {
  readonly running: boolean;
  readonly health: ContainerHealth;
}

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function healthStatus(value: unknown): ContainerHealth | null {
  if (value === null || value === undefined) return null;
  const health = record(value);
  if (!health) throw new Error('Invalid container health inspection.');
  const status = health.Status;
  if (status === undefined || status === '') return null;
  if (status === 'starting' || status === 'healthy' || status === 'unhealthy') return status;
  throw new Error(`Invalid container health state: ${String(status)}`);
}

/** Decode one current Docker/Podman inspect result, never a potentially evicted event. */
export function parseContainerState(output: string): ContainerState {
  let decoded: unknown;
  try {
    decoded = JSON.parse(output) as unknown;
  } catch {
    throw new Error('Invalid container inspection JSON.');
  }
  if (!Array.isArray(decoded) || decoded.length !== 1) {
    throw new Error('Expected exactly one inspected container.');
  }
  const state = record(record(decoded[0])?.State);
  if (typeof state?.Running !== 'boolean') throw new Error('Invalid container running state.');
  const dockerHealth = healthStatus(state.Health);
  const podmanHealth = healthStatus(state.Healthcheck);
  if (dockerHealth && podmanHealth && dockerHealth !== podmanHealth) {
    throw new Error('Conflicting container health states.');
  }
  const health = dockerHealth ?? podmanHealth;
  if (!health) throw new Error('Container inspection has no health state.');
  return { running: state.Running, health };
}

export interface HealthWaitIo {
  readonly label?: string;
  readonly inspect: () => Promise<ContainerState>;
  readonly now: () => number;
  readonly sleep: (milliseconds: number) => Promise<void>;
}

const HEALTH_BUDGET_MS = 120_000;
const HEALTH_RECHECK_MS = 1_000;

/** Accept an already-healthy container immediately, including after a slow checkout/install. */
export async function awaitPostgresqlHealth(startedAtMs: number, io: HealthWaitIo): Promise<void> {
  const deadline = startedAtMs + HEALTH_BUDGET_MS;
  const label = io.label ?? 'PostgreSQL';
  for (;;) {
    const state = await io.inspect();
    if (!state.running) throw new Error(`${label} container stopped with health ${state.health}.`);
    if (state.health === 'healthy') return;
    if (state.health === 'unhealthy') throw new Error(`${label} container became unhealthy.`);
    const remaining = deadline - io.now();
    if (remaining <= 0) {
      throw new Error(`${label} container remained starting after the 120-second health budget.`);
    }
    await io.sleep(Math.min(HEALTH_RECHECK_MS, remaining));
  }
}
