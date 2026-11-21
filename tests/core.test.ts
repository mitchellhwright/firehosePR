import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, renameSync, rmSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { balanceTests, configSchema, decideReuse, gitTreeDigest, hash, planChanges,
  planRepository, requireLaneResults, requirePromotion, resolveCommit } from '../src/core.ts';

const a = 'a'.repeat(40), b = 'b'.repeat(40), tree = hash('tree');
const config = { schemaVersion: 1, ignoredPaths: ['docs/'], lanes: [
  { id: 'api', inputs: ['api/', 'shared/'], command: ['npm', 'run', 'test:api'] },
  { id: 'web', inputs: ['web/', 'shared/'], command: ['npm', 'run', 'test:web'] },
] };
const plan = (changed: string[], full = false) => planChanges(config, changed, { base: a, head: b, treeDigest: tree, full });

test('affected ownership selects one lane; shared inputs select both', () => {
  assert.deepEqual(plan(['api/handler.ts']).lanes.map(l => l.id), ['api']);
  assert.deepEqual(plan(['shared/types.ts']).lanes.map(l => l.id), ['api', 'web']);
});
test('unknown changes and global inputs fall back to all lanes', () => {
  assert.ok(plan(['new-area/file.ts']).lanes.every(l => l.reason === 'unowned-change'));
  assert.equal(plan(['package-lock.json']).lanes.length, 2);
  assert.ok(plan(['.github/workflows/new.yml']).lanes.every(l => l.reason === 'global-input'));
});
test('only explicitly ignored paths skip lanes; full mode overrides', () => {
  assert.deepEqual(plan(['docs/readme.md']).lanes, []);
  assert.equal(plan(['docs/readme.md'], true).lanes.length, 2);
  assert.equal(plan([], true).lanes.length, 2);
  assert.equal(plan(['README.md']).lanes.length, 2);
});
test('ignored paths cannot mask declared lane or global inputs', () => {
  const p = planChanges({ ...config, ignoredPaths: ['api/', 'package.json'] }, ['api/a.ts', 'package.json'],
    { base: a, head: b, treeDigest: tree });
  assert.deepEqual(p.ignored, []); assert.equal(p.lanes.length, 2);
});
test('config rejects duplicates, traversal, globs, empty inventories and invalid counts', () => {
  for (const change of [{ maxShards: 0 }, { maxShards: 65 }, { ignoredPaths: ['../x'] },
    { ignoredPaths: ['src/**'] }, { lanes: [config.lanes[0], config.lanes[0]] },
    { lanes: [{ ...config.lanes[0], tests: [] }] }, { accidentalTypo: true }])
    assert.equal(configSchema.safeParse({ ...config, ...change }).success, false);
  assert.throws(() => plan(['../../outside']));
});
test('weighted sharding balances heavy tests and preserves each test exactly once', () => {
  const tests = [10, 9, 8, 7, 6].map((seconds, i) => ({ path: `tests/${i}.test.ts`, seconds }));
  const shards = balanceTests(tests, 3);
  assert.deepEqual(shards.map(s => s.estimatedSeconds), [10, 15, 15]);
  assert.deepEqual(shards.flatMap(s => s.tests).sort(), tests.map(t => t.path));
  assert.deepEqual(shards, balanceTests([...tests].reverse(), 3));
  assert.equal(balanceTests(tests, 64).length, 5);
  assert.deepEqual(balanceTests([], 4), []);
  assert.throws(() => balanceTests([tests[0]!, tests[0]!], 2));
  assert.throws(() => balanceTests([{ path: 'a', seconds: NaN }], 1));
});
test('aggregate rejects missing, failed, skipped and cancelled shards', () => {
  const p = plan(['api/handler.ts']);
  requireLaneResults(p, { api: ['success'] });
  for (const result of [[], ['skipped'], ['failure'], ['cancelled'], ['success', 'success']])
    assert.throws(() => requireLaneResults(p, { api: result }));
  assert.throws(() => requireLaneResults(p, {}));
});

const receipt = { repository: 'owner/repo', workflowId: 3, runId: 20, runAttempt: 2,
  headSha: a, testedSha: b, lane: 'api', treeDigest: tree, configDigest: hash('config'),
  environmentDigest: hash('node24-linux'), obligations: ['unit', 'integration'] };
const producer = { ...receipt, latestCompletedRunId: 20, conclusion: 'success',
  laneConclusions: { api: 'success' }, trustedWorkflow: true, trustedReceipt: true };
const candidate = { ...receipt, obligations: ['unit'] };
test('exact inputs and authenticated successful producer permit explicitly labeled reuse', () => {
  assert.deepEqual(decideReuse(receipt, producer, candidate), { kind: 'reuse', sourceRun: 20, sourceAttempt: 2 });
});
test('reuse refuses missing trust, latest run failure, attempts, provenance and scope mismatches', () => {
  for (const change of [{ trustedWorkflow: false }, { trustedReceipt: false }, { latestCompletedRunId: 21 },
    { runAttempt: 3 }, { workflowId: 4 }, { repository: 'other/repo' }, { headSha: b },
    { testedSha: a }, { conclusion: 'failure' }, { laneConclusions: { api: 'skipped' } }])
    assert.equal(decideReuse(receipt, { ...producer, ...change }, candidate).kind, 'execute');
  for (const change of [{ treeDigest: hash('different') }, { configDigest: hash('new policy') },
    { environmentDigest: hash('new toolchain') }, { obligations: ['new-check'] }, { headSha: b }])
    assert.equal(decideReuse(receipt, producer, { ...candidate, ...change }).kind, 'execute');
  assert.equal(decideReuse({ ...receipt, runId: 0 }, producer, candidate).kind, 'execute');
});
test('promotion binds current source, tested SHA, artifact and all required checks', () => {
  const promotion = { sourceSha: a, currentMainSha: a, testedSha: a, artifactDigest: tree,
    expectedArtifactDigest: tree, environment: 'production', expectedEnvironment: 'production',
    requiredChecks: { ci: 'success', smoke: 'success' } };
  requirePromotion(promotion);
  for (const change of [{ currentMainSha: b }, { testedSha: b }, { artifactDigest: hash('wrong') },
    { environment: 'staging' }, { requiredChecks: {} }, { requiredChecks: { ci: 'skipped' } }])
    assert.throws(() => requirePromotion({ ...promotion, ...change }));
});

test('real Git planning includes deletions, both rename owners, modes and immutable refs', t => {
  const root = mkdtempSync(join(tmpdir(), 'fpr-git-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const git = (...args: string[]) => execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  git('init', '-b', 'main'); git('config', 'user.name', 'Test'); git('config', 'user.email', 'test@example.invalid');
  mkdirSync(join(root, 'api')); mkdirSync(join(root, 'web'));
  writeFileSync(join(root, 'api/a.ts'), 'original');
  git('add', '.'); git('commit', '-m', 'base'); const base = git('rev-parse', 'HEAD');
  renameSync(join(root, 'api/a.ts'), join(root, 'web/a.ts'));
  git('add', '-A'); git('commit', '-m', 'rename');
  const p = planRepository(root, config, base, 'HEAD');
  assert.deepEqual(p.changed, ['api/a.ts', 'web/a.ts']); assert.equal(p.lanes.length, 2);
  assert.notEqual(gitTreeDigest(root, base), p.treeDigest);
  const original = p.treeDigest;
  git('commit', '--allow-empty', '-m', 'same tree');
  assert.equal(gitTreeDigest(root, 'HEAD'), original);
  git('update-index', '--chmod=+x', 'web/a.ts'); git('commit', '-m', 'mode change');
  assert.notEqual(gitTreeDigest(root, 'HEAD'), original);
  assert.throws(() => resolveCommit(root, '--help'));
  assert.throws(() => planRepository(root, config, 'missing-ref', 'HEAD'));
});

test('an explicit test inventory cannot be masked by ignored paths', () => {
  const p = planChanges({ ...config, ignoredPaths: ['special/'], lanes: [
    { ...config.lanes[0], tests: [{ path: 'special/a.test.ts', seconds: 1 }] }, config.lanes[1],
  ] }, ['special/a.test.ts'], { base: a, head: b, treeDigest: tree });
  assert.deepEqual(p.ignored, []);
  assert.deepEqual(p.lanes.map(lane => lane.id), ['api']);
});

test('repository CI inventory includes every portable regression file', () => {
  const root = new URL('../', import.meta.url);
  const config = configSchema.parse(JSON.parse(readFileSync(new URL('firehosepr.json', root), 'utf8')));
  const declared = config.lanes.flatMap(lane => lane.tests?.map(test => test.path) ?? []).sort();
  const actual = ['tests', 'ci/tests'].flatMap(dir => readdirSync(new URL(`${dir}/`, root))
    .filter(file => file.endsWith('.test.ts')).map(file => `${dir}/${file}`)).sort();
  assert.deepEqual(declared, actual);
});
