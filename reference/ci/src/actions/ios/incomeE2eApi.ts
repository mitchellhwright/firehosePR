#!/usr/bin/env node

import { createHash } from 'node:crypto';
import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises';
import http from 'node:http';
import https from 'node:https';
import { resolve } from 'node:path';
import type { IncomingHttpHeaders, OutgoingHttpHeaders } from 'node:http';
import { z } from 'zod';

const provisionResponseSchema = z.object({
  confirmed: z.boolean(),
  profileComplete: z.boolean(),
  userId: z.string(),
  cleanupToken: z.string(),
}).passthrough();
const loginResponseSchema = z.object({
  session: z.object({
    accessToken: z.string().optional(),
    access_token: z.string().optional(),
  }).passthrough(),
  user: z.object({ id: z.string() }).passthrough(),
}).passthrough();
const profileEnvelopeSchema = z.object({
  profile: z.object({ cardState: z.number() }).passthrough(),
  incomeEmployment: z.unknown().nullish(),
}).passthrough();
const profileResponseSchema = z.object({ profile: profileEnvelopeSchema }).passthrough();
const zeroIncomeSchema = z.object({
  cardState: z.number(),
  noCurrentIncome: z.boolean(),
  workForMyself: z.boolean(),
  hasOtherIncome: z.boolean(),
  employers: z.array(z.unknown()).nullish(),
  additionalIncomeSources: z.array(z.unknown()).nullish(),
  companyOwner: z.object({ selfEmploymentIncome: z.number() }).nullish(),
  spouseEmployers: z.array(z.unknown()).nullish(),
  spouseCompanyOwner: z.object({ selfEmploymentIncome: z.number() }).nullish(),
}).passthrough();
const runtimeSchema = z.object({
  email: z.string(),
  password: z.string().optional(),
  authUserId: z.string(),
  cleanupToken: z.string(),
  accessToken: z.string().optional(),
});
const cleanupResponseSchema = z.object({
  deleted: z.boolean(),
  verified: z.boolean(),
}).passthrough();

interface JSONRequestOptions {
  readonly method?: string;
  readonly body?: string;
  readonly headers?: OutgoingHttpHeaders;
}

interface BufferedResponse {
  readonly status: number;
  readonly headers: IncomingHttpHeaders;
  readonly text: string;
}

function argument(name: string): string {
  const index = process.argv.indexOf(`--${name}`);
  if (index < 0 || index + 1 >= process.argv.length) {
    throw new Error(`Missing --${name}`);
  }
  const value = process.argv[index + 1];
  if (value === undefined) throw new Error(`Missing --${name}`);
  return value;
}

async function readTrimmed(path: string): Promise<string> {
  return (await readFile(path, 'utf8')).trim();
}

async function requestJSON<TSchema extends z.ZodType>(
  url: string | URL,
  schema: TSchema,
  options: JSONRequestOptions = {},
): Promise<{
  readonly payload: z.output<TSchema>;
  readonly headers: { readonly get: (name: string) => string | null };
}> {
  const target = new URL(url);
  const client = target.protocol === 'https:' ? https : http;
  const method = options.method ?? 'GET';
  const body = options.body ?? undefined;
  const response = await new Promise<BufferedResponse>((resolveRequest, rejectRequest) => {
    const request = client.request(target, {
      method,
      headers: {
        ...(options.headers ?? {}),
        ...(body ? { 'Content-Length': Buffer.byteLength(body) } : {}),
      },
      timeout: 30_000,
    }, (incoming) => {
      const chunks: Buffer[] = [];
      incoming.on('data', chunk => chunks.push(chunk));
      incoming.on('end', () => resolveRequest({
        status: incoming.statusCode ?? 0,
        headers: incoming.headers,
        text: Buffer.concat(chunks).toString('utf8'),
      }));
    });
    request.on('timeout', () => request.destroy(new Error('request timed out')));
    request.on('error', rejectRequest);
    if (body) request.write(body);
    request.end();
  });
  const text = response.text;
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error(`${method} ${target.pathname} returned non-JSON HTTP ${response.status}`);
  }
  if (response.status < 200 || response.status >= 300) {
    throw new Error(`${method} ${target.pathname} returned HTTP ${response.status}: ${JSON.stringify(parsed)}`);
  }
  const payload = schema.parse(parsed);
  return {
    payload,
    headers: {
      get(name: string): string | null {
        const value = response.headers[name.toLowerCase()];
        return Array.isArray(value) ? value.join(', ') : value ?? null;
      },
    },
  };
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function assertZeroIncome(profileValue: unknown, expectedState: number): void {
  const profile = profileEnvelopeSchema.parse(profileValue);
  const income = zeroIncomeSchema.parse(profile.incomeEmployment);
  assert(income.cardState === expectedState, `incomeEmployment.cardState was ${income.cardState}, expected ${expectedState}`);
  assert(income.noCurrentIncome === true, 'noCurrentIncome was not true');
  assert(income.workForMyself === false, 'workForMyself was not false');
  assert(income.hasOtherIncome === false, 'hasOtherIncome was not false');
  assert(
    income.employers == null || (Array.isArray(income.employers) && income.employers.length === 0),
    'employers was not empty',
  );
  assert(
    income.additionalIncomeSources == null
      || (Array.isArray(income.additionalIncomeSources) && income.additionalIncomeSources.length === 0),
    'additionalIncomeSources was not empty',
  );
  assert(income.companyOwner?.selfEmploymentIncome === 0, 'selfEmploymentIncome was not zero');
  assert(!Array.isArray(income.spouseEmployers) || income.spouseEmployers.length === 0, 'spouseEmployers was not empty');
  assert(
    income.spouseCompanyOwner == null || income.spouseCompanyOwner.selfEmploymentIncome === 0,
    'spouse self-employment income was not absent or zero',
  );
}

function assertResetProfile(profileValue: unknown): void {
  const profile = profileEnvelopeSchema.parse(profileValue);
  assert(profile.profile.cardState === 1, 'Profile foundation is not activated');
  assert(profile.incomeEmployment == null, 'Income must be absent after the supported reset');
}

async function writeProtectedJSON(path: string, value: unknown): Promise<void> {
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  await chmod(path, 0o600);
}

async function prepare(): Promise<void> {
  const baseURL = argument('base-url').replace(/\/$/, '');
  const runDirectory = resolve(argument('run-dir'));
  const email = await readTrimmed(argument('email-file'));
  const password = await readTrimmed(argument('password-file'));
  const secret = await readTrimmed(argument('secret-file'));
  const secretHeaders = secret ? { 'x-test-otp-secret': secret } : {};
  const jsonHeaders = { Accept: 'application/json', 'Content-Type': 'application/json', ...secretHeaders };
  await mkdir(runDirectory, { recursive: true, mode: 0o700 });

  const provision = await requestJSON(`${baseURL}/auth/test/otp`, provisionResponseSchema, {
    method: 'POST',
    headers: jsonHeaders,
    body: JSON.stringify({ email, password, profileComplete: true }),
  });
  assert(provision.payload.confirmed === true, 'synthetic identity was not confirmed');
  assert(provision.payload.profileComplete === true, 'complete Profile foundation was not requested');
  assert(typeof provision.payload.userId === 'string', 'provisioning response omitted userId');
  assert(typeof provision.payload.cleanupToken === 'string', 'provisioning response omitted signed cleanup token');

  // Persist the minimum cleanup capability before writing credentials or doing
  // follow-up work. If even that first durable write fails, delete the identity
  // directly with the still-in-memory signed capability.
  const cleanupRuntime = {
    email,
    authUserId: provision.payload.userId,
    cleanupToken: provision.payload.cleanupToken,
  };
  try {
    await writeProtectedJSON(`${runDirectory}/cleanup-runtime.json`, cleanupRuntime);
  } catch (persistenceError) {
    const cleanupURL = new URL(`${baseURL}/auth/test/user`);
    cleanupURL.searchParams.set('email', email);
    try {
      const cleanupResponse = await requestJSON(cleanupURL, cleanupResponseSchema, {
        method: 'DELETE',
        headers: {
          Accept: 'application/json',
          ...secretHeaders,
          'x-test-user-cleanup-token': provision.payload.cleanupToken,
        },
      });
      assert(cleanupResponse.payload.deleted === true, 'emergency cleanup did not report deleted=true');
      assert(cleanupResponse.payload.verified === true, 'emergency cleanup did not report verified=true');
    } catch (cleanupError) {
      throw new AggregateError(
        [persistenceError, cleanupError],
        'cleanup authority persistence and emergency identity cleanup both failed',
      );
    }
    throw persistenceError;
  }

  const runtime: z.output<typeof runtimeSchema> = {
    email,
    password,
    authUserId: provision.payload.userId,
    cleanupToken: provision.payload.cleanupToken,
  };
  await writeProtectedJSON(`${runDirectory}/runtime.json`, runtime);
  await writeProtectedJSON(`${runDirectory}/ownership.json`, {
    authUserId: provision.payload.userId,
    emailSha256: createHash('sha256').update(email).digest('hex'),
    profileComplete: true,
  });

  const login = await requestJSON(`${baseURL}/auth/login`, loginResponseSchema, {
    method: 'POST',
    headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password }),
  });
  const accessToken = login.payload.session?.accessToken ?? login.payload.session?.access_token;
  assert(typeof accessToken === 'string' && accessToken.length > 0, 'real login returned no bearer token');
  assert(login.payload.user?.id === provision.payload.userId, 'login UID did not match provisioning UID');
  const authHeaders = { Accept: 'application/json', Authorization: `Bearer ${accessToken}` };

  const initial = await requestJSON(`${baseURL}/users/profile`, profileResponseSchema, { headers: authHeaders });
  assertResetProfile(initial.payload.profile);
  assert((initial.headers.get('cache-control') ?? '').includes('no-store'), 'initial GET was not no-store');
  await writeProtectedJSON(`${runDirectory}/initial-profile.json`, initial.payload);

  const patchProfile = structuredClone(initial.payload.profile);
  patchProfile.incomeEmployment = {
    cardState: 1,
    noCurrentIncome: true,
    workForMyself: false,
    hasOtherIncome: false,
    employers: [],
    additionalIncomeSources: [],
    companyOwner: { selfEmploymentIncome: 0 },
  };
  const patch = await requestJSON(`${baseURL}/users/profile`, profileResponseSchema, {
    method: 'PATCH',
    headers: { ...authHeaders, 'Content-Type': 'application/json' },
    body: JSON.stringify({ profile: patchProfile }),
  });
  assertZeroIncome(patch.payload.profile, 1);
  await writeProtectedJSON(`${runDirectory}/patch-response.json`, patch.payload);

  const readback = await requestJSON(`${baseURL}/users/profile`, profileResponseSchema, { headers: authHeaders });
  assertZeroIncome(readback.payload.profile, 1);
  assert((readback.headers.get('cache-control') ?? '').includes('no-store'), 'readback GET was not no-store');
  await writeProtectedJSON(`${runDirectory}/api-readback.json`, readback.payload);

  runtime.accessToken = accessToken;
  await writeProtectedJSON(`${runDirectory}/runtime.json`, runtime);
  process.stdout.write(`${provision.payload.userId}\n`);
}

async function reset(): Promise<void> {
  const baseURL = argument('base-url').replace(/\/$/, '');
  const runDirectory = resolve(argument('run-dir'));
  const secret = await readTrimmed(argument('secret-file'));
  const runtime = runtimeSchema.parse(JSON.parse(await readFile(`${runDirectory}/runtime.json`, 'utf8')));
  const secretHeaders = secret ? { 'x-test-otp-secret': secret } : {};
  const resetResponse = await requestJSON(`${baseURL}/auth/test/otp`, provisionResponseSchema, {
    method: 'POST',
    headers: { Accept: 'application/json', 'Content-Type': 'application/json', ...secretHeaders },
    body: JSON.stringify({ email: runtime.email, profileComplete: true }),
  });
  assert(resetResponse.payload.userId === runtime.authUserId, 'reset UID did not match the owned identity');
  if (typeof resetResponse.payload.cleanupToken === 'string') {
    runtime.cleanupToken = resetResponse.payload.cleanupToken;
    await writeProtectedJSON(`${runDirectory}/runtime.json`, runtime);
    const cleanupRuntime = runtimeSchema.parse(
      JSON.parse(await readFile(`${runDirectory}/cleanup-runtime.json`, 'utf8')),
    );
    cleanupRuntime.cleanupToken = resetResponse.payload.cleanupToken;
    await writeProtectedJSON(`${runDirectory}/cleanup-runtime.json`, cleanupRuntime);
  }
  assert(runtime.accessToken, 'runtime access token is missing');
  const readback = await requestJSON(`${baseURL}/users/profile`, profileResponseSchema, {
    headers: { Accept: 'application/json', Authorization: `Bearer ${runtime.accessToken}` },
  });
  assertResetProfile(readback.payload.profile);
  assert((readback.headers.get('cache-control') ?? '').includes('no-store'), 'reset GET was not no-store');
  await writeProtectedJSON(`${runDirectory}/reset-readback.json`, readback.payload);
  process.stdout.write(`${runtime.authUserId}\n`);
}

async function verifyUI(): Promise<void> {
  const baseURL = argument('base-url').replace(/\/$/, '');
  const runDirectory = resolve(argument('run-dir'));
  const runtime = runtimeSchema.parse(JSON.parse(await readFile(`${runDirectory}/runtime.json`, 'utf8')));
  assert(runtime.accessToken, 'runtime access token is missing');
  const readback = await requestJSON(`${baseURL}/users/profile`, profileResponseSchema, {
    headers: { Accept: 'application/json', Authorization: `Bearer ${runtime.accessToken}` },
  });
  await writeProtectedJSON(`${runDirectory}/post-ui-api-readback.json`, readback.payload);
  assertZeroIncome(readback.payload.profile, 1);
  assert((readback.headers.get('cache-control') ?? '').includes('no-store'), 'post-UI GET was not no-store');
  process.stdout.write(`${runtime.authUserId}\n`);
}

async function cleanup(): Promise<void> {
  const baseURL = argument('base-url').replace(/\/$/, '');
  const runDirectory = resolve(argument('run-dir'));
  const secret = await readTrimmed(argument('secret-file'));
  const runtime = runtimeSchema.parse(JSON.parse(await readFile(`${runDirectory}/cleanup-runtime.json`, 'utf8')));
  const url = new URL(`${baseURL}/auth/test/user`);
  url.searchParams.set('email', runtime.email);
  const response = await requestJSON(url, cleanupResponseSchema, {
    method: 'DELETE',
    headers: {
      Accept: 'application/json',
      ...(secret ? { 'x-test-otp-secret': secret } : {}),
      'x-test-user-cleanup-token': runtime.cleanupToken,
    },
  });
  assert(response.payload.deleted === true, 'cleanup did not report deleted=true');
  assert(response.payload.verified === true, 'cleanup did not report verified=true');
  await writeProtectedJSON(`${runDirectory}/cleanup-receipt.json`, response.payload);
}

const command = process.argv[2];
if (command === 'prepare') {
  await prepare();
} else if (command === 'reset') {
  await reset();
} else if (command === 'verify-ui') {
  await verifyUI();
} else if (command === 'cleanup') {
  await cleanup();
} else {
  throw new Error('Expected one of: prepare, reset, verify-ui, cleanup');
}
