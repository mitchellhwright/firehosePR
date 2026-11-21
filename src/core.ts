import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { z } from 'zod';

const sha = z.string().regex(/^[0-9a-f]{40}$/u);
const digest = z.string().regex(/^[0-9a-f]{64}$/u);
const id = z.string().regex(/^[a-z][a-z0-9-]{0,62}$/u);
const path = z.string().min(1).refine(value =>
  !value.startsWith('/') && !value.includes('\\') && !value.includes('\0')
  && !value.split('/').includes('..') && !value.startsWith('-')
  && !/[\n\r*?\[\]]/u.test(value), 'Use a repository-relative file or directory prefix, without globs or traversal.');
const testSchema = z.strictObject({ path, seconds: z.number().positive().finite().default(30) });
const laneSchema = z.strictObject({
  id, inputs: z.array(path).min(1),
  command: z.array(z.string().min(1)).min(1),
  tests: z.array(testSchema).optional(),
});
export const configSchema = z.strictObject({
  schemaVersion: z.literal(1),
  globalInputs: z.array(path).default(['package.json', 'package-lock.json', '.github/', 'firehosepr.json']),
  ignoredPaths: z.array(path).default([]),
  maxShards: z.number().int().min(1).max(64).default(4),
  lanes: z.array(laneSchema).min(1),
}).superRefine((config, ctx) => {
  if (new Set(config.lanes.map(lane => lane.id)).size !== config.lanes.length)
    ctx.addIssue({ code: 'custom', message: 'Lane IDs must be unique.' });
  for (const lane of config.lanes) {
    if (lane.tests && (lane.tests.length === 0 || new Set(lane.tests.map(test => test.path)).size !== lane.tests.length))
      ctx.addIssue({ code: 'custom', message: `Lane ${lane.id} needs unique, nonempty tests.` });
  }
});
export type Config = z.infer<typeof configSchema>;
export type WeightedTest = z.infer<typeof testSchema>;
export interface Shard { tests: string[]; estimatedSeconds: number }
export interface PlannedLane {
  id: string; reason: 'full' | 'global-input' | 'unowned-change' | 'affected';
  command: string[]; shards: Shard[];
}
export interface Plan {
  schemaVersion: 1; base: string; head: string; treeDigest: string; configDigest: string;
  changed: string[]; ignored: string[]; lanes: PlannedLane[];
}

export function hash(value: string | Buffer): string {
  return createHash('sha256').update(value).digest('hex');
}
function matches(file: string, prefixes: readonly string[]): boolean {
  return prefixes.some(prefix => prefix.endsWith('/') ? file.startsWith(prefix) : file === prefix);
}

/** Longest-processing-time first, deterministic tie breaking. Never drops a test. */
export function balanceTests(tests: readonly WeightedTest[], count: number): Shard[] {
  z.number().int().min(1).max(64).parse(count);
  const parsed = z.array(testSchema).parse(tests);
  if (new Set(parsed.map(test => test.path)).size !== parsed.length) throw new Error('Duplicate test paths.');
  const shards: Shard[] = Array.from({ length: Math.min(count, parsed.length) }, () => ({ tests: [], estimatedSeconds: 0 }));
  for (const test of parsed.sort((a, b) => b.seconds - a.seconds || a.path.localeCompare(b.path))) {
    const lightest = shards.reduce((a, b) => a.estimatedSeconds <= b.estimatedSeconds ? a : b);
    lightest.tests.push(test.path);
    lightest.estimatedSeconds += test.seconds;
  }
  for (const shard of shards) shard.tests.sort();
  return shards;
}

/** Explicit ownership is a consumer contract; unknown paths select ALL lanes. */
export function planChanges(rawConfig: unknown, changedFiles: readonly string[], options: {
  base: string; head: string; treeDigest: string; full?: boolean;
}): Plan {
  const config = configSchema.parse(rawConfig);
  sha.parse(options.base); sha.parse(options.head); digest.parse(options.treeDigest);
  const changed = [...new Set(z.array(path).parse(changedFiles))].sort();
  const global = changed.some(file => matches(file, config.globalInputs));
  // An owned or global input always wins over an ignored-path declaration.
  const ignored = changed.filter(file => matches(file, config.ignoredPaths)
    && !matches(file, config.globalInputs) && !config.lanes.some(lane => matches(file, lane.inputs) || lane.tests?.some(test => test.path === file)));
  const relevant = changed.filter(file => !ignored.includes(file));
  const unowned = relevant.some(file => !matches(file, config.globalInputs)
    && !config.lanes.some(lane => matches(file, lane.inputs) || lane.tests?.some(test => test.path === file)));
  const lanes: PlannedLane[] = config.lanes.flatMap(lane => {
    const reason = options.full ? 'full' : global ? 'global-input' : unowned ? 'unowned-change'
      : relevant.some(file => matches(file, lane.inputs) || lane.tests?.some(test => test.path === file)) ? 'affected' : undefined;
    if (!reason) return [];
    return [{ id: lane.id, reason, command: lane.command,
      shards: lane.tests ? balanceTests(lane.tests, config.maxShards) : [{ tests: [], estimatedSeconds: 0 }] }];
  });
  return { schemaVersion: 1, base: options.base, head: options.head, treeDigest: options.treeDigest,
    configDigest: hash(JSON.stringify(config)), changed, ignored, lanes };
}

function git(root: string, args: readonly string[]): string {
  return execFileSync('git', [...args], {
    cwd: root, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, timeout: 30_000,
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_NO_LAZY_FETCH: '1' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}
/** Resolve refs first, then pass only immutable IDs to subsequent Git operations. */
export function resolveCommit(root: string, ref: string): string {
  if (!ref || ref.startsWith('-') || /[\0\r\n]/u.test(ref)) throw new Error('Invalid Git revision.');
  return sha.parse(git(root, ['rev-parse', '--verify', '--end-of-options', `${ref}^{commit}`]).trim());
}
export function gitTreeDigest(root: string, ref: string): string {
  const commit = resolveCommit(root, ref);
  // Includes every tracked entry, its mode, path and Git object ID. No ignored-doc shortcut.
  return hash(git(root, ['ls-tree', '-r', '-z', '--full-tree', commit]));
}
export function planRepository(root: string, config: unknown, baseRef: string, headRef: string, full = false): Plan {
  const base = resolveCommit(root, baseRef);
  const head = resolveCommit(root, headRef);
  // A rename becomes deletion + addition, so both old and new owners are selected.
  const changed = git(root, ['diff', '--no-ext-diff', '--no-renames', '--name-only', '-z', base, head, '--']).split('\0').filter(Boolean);
  return planChanges(config, changed, { base, head, treeDigest: gitTreeDigest(root, head), full });
}

export interface EvidenceReceipt {
  repository: string; workflowId: number; runId: number; runAttempt: number;
  headSha: string; testedSha: string; lane: string;
  treeDigest: string; configDigest: string; environmentDigest: string;
  obligations: readonly string[];
}
/** These facts MUST come from authenticated GitHub reads, not from the receipt. */
export interface VerifiedProducer {
  repository: string; workflowId: number; runId: number; runAttempt: number;
  headSha: string; testedSha: string; latestCompletedRunId: number;
  conclusion: string; laneConclusions: Readonly<Record<string, string>>;
  trustedWorkflow: boolean; trustedReceipt: boolean;
}
export type ReuseDecision = { kind: 'reuse'; sourceRun: number; sourceAttempt: number }
  | { kind: 'execute'; reason: string };
/** Pure decision only. No API mutation, cancellation, cache write, or check relabeling. */
export function decideReuse(receipt: EvidenceReceipt, producer: VerifiedProducer, candidate: {
  repository: string; workflowId: number; headSha: string; lane: string;
  treeDigest: string; configDigest: string; environmentDigest: string;
  obligations: readonly string[];
}): ReuseDecision {
  const refuse = (reason: string): ReuseDecision => ({ kind: 'execute', reason });
  if (!producer.trustedWorkflow || !producer.trustedReceipt) return refuse('untrusted-producer');
  if (!sha.safeParse(receipt.headSha).success || !sha.safeParse(receipt.testedSha).success
    || !sha.safeParse(candidate.headSha).success
    || ![receipt.treeDigest, receipt.configDigest, receipt.environmentDigest,
      candidate.treeDigest, candidate.configDigest, candidate.environmentDigest].every(value => digest.safeParse(value).success))
    return refuse('invalid-receipt');
  if (![receipt.runId, receipt.runAttempt, receipt.workflowId].every(value => Number.isSafeInteger(value) && value > 0))
    return refuse('invalid-producer-id');
  if (producer.repository !== candidate.repository || receipt.repository !== candidate.repository
    || producer.workflowId !== candidate.workflowId || receipt.workflowId !== candidate.workflowId
    || producer.runId !== receipt.runId || producer.runAttempt !== receipt.runAttempt
    || producer.headSha !== receipt.headSha || producer.testedSha !== receipt.testedSha
    || receipt.headSha !== candidate.headSha || receipt.lane !== candidate.lane)
    return refuse('producer-mismatch');
  if (producer.latestCompletedRunId !== receipt.runId) return refuse('superseded-evidence');
  if (producer.conclusion !== 'success' || producer.laneConclusions[candidate.lane] !== 'success')
    return refuse('producer-did-not-pass');
  if (receipt.treeDigest !== candidate.treeDigest || receipt.configDigest !== candidate.configDigest
    || receipt.environmentDigest !== candidate.environmentDigest) return refuse('inputs-changed');
  if (!candidate.obligations.every(item => receipt.obligations.includes(item))) return refuse('missing-obligation');
  return { kind: 'reuse', sourceRun: receipt.runId, sourceAttempt: receipt.runAttempt };
}

export function requireLaneResults(plan: Pick<Plan, 'lanes'>, results: Readonly<Record<string, readonly string[]>>): void {
  for (const lane of plan.lanes) {
    const actual = results[lane.id];
    if (!actual || actual.length !== lane.shards.length || actual.some(result => result !== 'success'))
      throw new Error(`Lane ${lane.id} did not execute and pass every planned shard.`);
  }
}

/** Promotion requires an exact tested source and environment-bound build identity. */
export function requirePromotion(input: {
  sourceSha: string; currentMainSha: string; testedSha: string;
  artifactDigest: string; expectedArtifactDigest: string;
  environment: string; expectedEnvironment: string; requiredChecks: Readonly<Record<string, string>>;
}): void {
  sha.parse(input.sourceSha); sha.parse(input.currentMainSha); sha.parse(input.testedSha);
  digest.parse(input.artifactDigest); digest.parse(input.expectedArtifactDigest);
  if (input.sourceSha !== input.currentMainSha || input.testedSha !== input.sourceSha
    || input.artifactDigest !== input.expectedArtifactDigest || !input.expectedEnvironment
    || input.environment !== input.expectedEnvironment || Object.keys(input.requiredChecks).length === 0
    || Object.values(input.requiredChecks).some(result => result !== 'success'))
    throw new Error('Promotion requires the exact current source, tested artifact, target environment, and passing checks.');
}
