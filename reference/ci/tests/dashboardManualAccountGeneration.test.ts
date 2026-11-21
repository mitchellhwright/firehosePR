import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import yaml from 'js-yaml';
import { generateSwiftTypes } from '../../scripts/generate-api-types.js';

interface ApiSchema {
  $ref?: string;
  items?: ApiSchema;
  properties?: Record<string, ApiSchema>;
  required?: string[];
  type?: string;
  'x-swift-standalone'?: boolean;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function loadSchemas(path: string): Record<string, ApiSchema> {
  const document = yaml.load(readFileSync(path, 'utf8'));
  assert.ok(isRecord(document));
  assert.ok(isRecord(document.components));
  assert.ok(isRecord(document.components.schemas));

  const schemas: Record<string, ApiSchema> = {};
  for (const [name, schema] of Object.entries(document.components.schemas)) {
    assert.ok(isRecord(schema), `${path} schema ${name} must be an object`);
    schemas[name] = schema;
  }
  return schemas;
}

function requireSchema(schemas: Record<string, ApiSchema>, name: string): ApiSchema {
  const schema = schemas[name];
  assert.ok(schema, `Missing schema ${name}`);
  return schema;
}

function requireProperty(schema: ApiSchema, name: string): ApiSchema {
  const property = schema.properties?.[name];
  assert.ok(property, `Missing property ${name}`);
  return property;
}

function generateDashboardTypes(
  schemas: Record<string, ApiSchema>,
  skipTypes: ReadonlySet<string> | null = null,
): string {
  const generated: unknown = Reflect.apply(generateSwiftTypes, undefined, [
    schemas,
    'Dashboard',
    skipTypes,
  ]);
  if (typeof generated !== 'string') {
    throw new TypeError('Swift type generator returned a non-string result');
  }
  return generated;
}

const dashboard = loadSchemas('server/routes/dashboard.yaml');
const profile = loadSchemas('server/swagger/userProfile.yaml');
const dashboardCashResponse = requireSchema(dashboard, 'CashSavingsDashboardResponse');
const dashboardManualAccount = requireSchema(dashboard, 'DashboardCashManualAccount');
const profileCashSavingsAccount = requireSchema(profile, 'CashSavingsManualAccount');
const profileManualAccount = requireSchema(profile, 'APIManualAccount');

test('dashboard manual reader is standalone and retains its own shape', () => {
  assert.equal(requireProperty(dashboardCashResponse, 'manualAccounts').items?.$ref,
    '#/components/schemas/DashboardCashManualAccount');
  const schema = dashboardManualAccount;
  assert.equal(schema['x-swift-standalone'], true);
  assert.equal(requireProperty(schema, 'balance').type, 'number');
  assert.deepEqual(schema.required, ['name', 'balance']);
  const swift = generateDashboardTypes({ DashboardCashManualAccount: schema });
  assert.match(swift, /public struct DashboardCashManualAccount:/);
  assert.match(swift, /public var name: String\n/);
  assert.match(swift, /public var balance: Double\n/);
  assert.match(swift, /public var id: String\?/);
  assert.match(swift, /public var rawBalance: Double\?/);
  assert.match(swift, /if container.contains\(\.rawBalance\) \{/);
  assert.match(swift, /self.rawBalance = try container.decode\(Double.self, forKey: \.rawBalance\)/);
  assert.doesNotMatch(swift, /nickname|APIManualAccount/);
});

test('dashboard shape cannot silently alias the differently shaped profile editor', () => {
  assert.equal(profileCashSavingsAccount.$ref, '#/components/schemas/APIManualAccount');
  assert.equal(requireProperty(profileManualAccount, 'balance').type, 'integer');
  assert.ok(requireProperty(profileManualAccount, 'nickname'));
  assert.equal(profileManualAccount.properties?.name, undefined);
  // Reproduce the original collision: same name, incompatible dashboard shape.
  assert.throws(() => generateDashboardTypes({
    CashSavingsManualAccount: dashboardManualAccount,
  }, new Set(['CashSavingsManualAccount'])), /Standalone schema.*collides/);
  // The ownership check must also work if a caller forgets the skip list.
  assert.throws(() => generateDashboardTypes({
    APIManualAccount: dashboardManualAccount,
  }), /Standalone schema.*collides/);
});

test('a new accidental skip of the dedicated reader fails generation', () => {
  assert.throws(() => generateDashboardTypes({
    DashboardCashManualAccount: dashboardManualAccount,
  }, new Set(['DashboardCashManualAccount'])), /Standalone schema.*collides/);
});

test('existing deliberate shared profile aliases still generate without duplication', () => {
  const swift = generateDashboardTypes({
    CashSavingsManualAccount: profileCashSavingsAccount,
    DashboardCashManualAccount: dashboardManualAccount,
  }, new Set(['CashSavingsManualAccount']));
  assert.doesNotMatch(swift, /typealias CashSavingsManualAccount/);
  assert.match(swift, /struct DashboardCashManualAccount/);
});
