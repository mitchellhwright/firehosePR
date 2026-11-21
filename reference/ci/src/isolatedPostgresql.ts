import { containerEngineCommand, runEngine, type ContainerEngineCommand } from './containerEngineCommand.ts';
import { requiredEnv } from './ios/shared/githubStepIo.ts';
import type { RunProcess } from './ios/shared/processRunner.ts';

/**
 * The PostgreSQL container a database lane owns: started under a name unique
 * to the job attempt, published on a port the engine picks, and addressed by
 * the later steps only through the variables exported here.
 */

export const POSTGRES_IMAGE = 'pgvector/pgvector:0.8.1-pg17';
const HOST = '127.0.0.1';
const PRIMARY_DATABASE = 'example';
const SUPERUSER = 'postgres';
const PASSWORD = 'postgres';
const DATABASE_NAME = /^[a-z_][a-z0-9_]*$/;

export type ExportEnv = (entries: Readonly<Record<string, string>>) => void;

export interface LaneDatabase {
  readonly engine: ContainerEngineCommand;
  readonly container: string;
  readonly run: RunProcess;
  readonly env: NodeJS.ProcessEnv;
}

/** The container `startIsolatedPostgresql` recorded for the rest of the job. */
export function laneDatabase(env: NodeJS.ProcessEnv, run: RunProcess): LaneDatabase {
  return {
    engine: containerEngineCommand(requiredEnv('DB_CONTAINER_CMD', env)),
    container: requiredEnv('DB_CONTAINER_NAME', env),
    run,
    env,
  };
}

/** `${DATABASE_URL%/example}/<name>`: another database on the lane's server. */
export function siblingDatabaseUrl(databaseUrl: string, database: string): string {
  const suffix = `/${PRIMARY_DATABASE}`;
  const server = databaseUrl.endsWith(suffix) ? databaseUrl.slice(0, -suffix.length) : databaseUrl;
  return `${server}/${database}`;
}

/** The host port from `<engine> port <container> 5432/tcp`: the last field of its first line. */
export function publishedPort(output: string): string {
  const port = output.split('\n')[0]?.split(':').at(-1)?.trim() ?? '';
  if (!/^[0-9]+$/.test(port)) throw new Error('Unable to resolve the PostgreSQL host port.');
  return port;
}

/** `psql` as the superuser, stopping at the first SQL error. */
function psqlCommand(database: string): readonly string[] {
  return ['psql', '-v', 'ON_ERROR_STOP=1', '-U', SUPERUSER, '-d', database];
}

/** One SQL statement run by `psql` inside the container. */
export function psqlExecArgs(container: string, database: string, statement: string): readonly string[] {
  return ['exec', container, ...psqlCommand(database), '-c', statement];
}

async function psql(
  lane: LaneDatabase,
  database: string,
  input: { readonly statement: string } | { readonly file: string },
): Promise<void> {
  // A SQL file on the runner reaches the container's psql through stdin.
  const result = 'statement' in input
    ? await runEngine(lane.engine, psqlExecArgs(lane.container, database, input.statement), lane.run, {
      env: lane.env,
    })
    : await runEngine(lane.engine, ['exec', '-i', lane.container, ...psqlCommand(database)], lane.run, {
      env: lane.env, stdinFile: input.file,
    });
  if (result.status !== 0) {
    const what = 'statement' in input ? input.statement : input.file;
    throw new Error(`psql on ${database} failed with exit ${result.status}: ${what}`);
  }
}

export function executeSql(lane: LaneDatabase, database: string, statement: string): Promise<void> {
  return psql(lane, database, { statement });
}

export function applySqlFile(lane: LaneDatabase, database: string, file: string): Promise<void> {
  return psql(lane, database, { file });
}

/** Creates `name` beside the primary database and returns its connection URL. */
export async function createSiblingDatabase(lane: LaneDatabase, name: string): Promise<string> {
  if (!DATABASE_NAME.test(name)) throw new Error(`Invalid database name: ${name}`);
  await executeSql(lane, PRIMARY_DATABASE, `CREATE DATABASE ${name}`);
  return siblingDatabaseUrl(requiredEnv('DATABASE_URL', lane.env), name);
}

export function removeContainer(
  engine: ContainerEngineCommand,
  container: string,
  run: RunProcess,
  env: NodeJS.ProcessEnv,
): ReturnType<RunProcess> {
  return runEngine(engine, ['rm', '-f', container], run, { capture: true, env });
}

export interface StartIo {
  readonly run: RunProcess;
  readonly now: () => number;
  readonly exportEnv: ExportEnv;
}

/**
 * Starts the lane's container and exports how to reach it. The container
 * name is exported as soon as the container exists, so the
 * always-run cleanup step can remove it even when the port lookup fails.
 */
export async function startIsolatedPostgresql(env: NodeJS.ProcessEnv, io: StartIo): Promise<void> {
  const engine = containerEngineCommand(requiredEnv('DB_CONTAINER_CMD', env));
  const container = [
    'gh-actions-pg', requiredEnv('GITHUB_JOB', env), requiredEnv('GITHUB_RUN_ID', env),
    requiredEnv('GITHUB_RUN_ATTEMPT', env),
  ].join('-');
  // A rerun on the same runner may find the previous attempt's container.
  await removeContainer(engine, container, io.run, env);
  const startedAt = Math.floor(io.now() / 1_000);
  const started = await runEngine(engine, [
    'run', '-d',
    '--name', container,
    '--health-cmd', `pg_isready -U ${SUPERUSER} -d ${PRIMARY_DATABASE}`,
    '--health-interval', '1s',
    '--health-retries', '30',
    '-e', `POSTGRES_DB=${PRIMARY_DATABASE}`,
    '-e', `POSTGRES_USER=${SUPERUSER}`,
    '-e', `POSTGRES_PASSWORD=${PASSWORD}`,
    '-p', `${HOST}::5432`,
    POSTGRES_IMAGE,
  ], io.run, { env });
  if (started.status !== 0) throw new Error(`PostgreSQL container failed to start (exit ${started.status}).`);
  io.exportEnv({ DB_CONTAINER_NAME: container, DB_STARTED_AT: String(startedAt) });

  const published = await runEngine(engine, ['port', container, '5432/tcp'], io.run, { capture: true, env });
  if (published.status !== 0) {
    throw new Error(
      `Unable to resolve the PostgreSQL host port (exit ${published.status}): ${published.stderr.trim()}`,
    );
  }
  const port = publishedPort(published.stdout);
  io.exportEnv({
    DATABASE_URL: `postgresql://${SUPERUSER}:${PASSWORD}@${HOST}:${port}/${PRIMARY_DATABASE}`,
    DB_HOST: HOST,
    DB_PORT: port,
    DB_USER: SUPERUSER,
    DB_PASSWORD: PASSWORD,
    DB_NAME: PRIMARY_DATABASE,
  });
}
