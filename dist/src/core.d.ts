import { z } from 'zod';
declare const testSchema: z.ZodObject<{
    path: z.ZodString;
    seconds: z.ZodDefault<z.ZodNumber>;
}, z.core.$strict>;
export declare const configSchema: z.ZodObject<{
    schemaVersion: z.ZodLiteral<1>;
    globalInputs: z.ZodDefault<z.ZodArray<z.ZodString>>;
    ignoredPaths: z.ZodDefault<z.ZodArray<z.ZodString>>;
    maxShards: z.ZodDefault<z.ZodNumber>;
    lanes: z.ZodArray<z.ZodObject<{
        id: z.ZodString;
        inputs: z.ZodArray<z.ZodString>;
        command: z.ZodArray<z.ZodString>;
        tests: z.ZodOptional<z.ZodArray<z.ZodObject<{
            path: z.ZodString;
            seconds: z.ZodDefault<z.ZodNumber>;
        }, z.core.$strict>>>;
    }, z.core.$strict>>;
}, z.core.$strict>;
export type Config = z.infer<typeof configSchema>;
export type WeightedTest = z.infer<typeof testSchema>;
export interface Shard {
    tests: string[];
    estimatedSeconds: number;
}
export interface PlannedLane {
    id: string;
    reason: 'full' | 'global-input' | 'unowned-change' | 'affected';
    command: string[];
    shards: Shard[];
}
export interface Plan {
    schemaVersion: 1;
    base: string;
    head: string;
    treeDigest: string;
    configDigest: string;
    changed: string[];
    ignored: string[];
    lanes: PlannedLane[];
}
export declare function hash(value: string | Buffer): string;
/** Longest-processing-time first, deterministic tie breaking. Never drops a test. */
export declare function balanceTests(tests: readonly WeightedTest[], count: number): Shard[];
/** Explicit ownership is a consumer contract; unknown paths select ALL lanes. */
export declare function planChanges(rawConfig: unknown, changedFiles: readonly string[], options: {
    base: string;
    head: string;
    treeDigest: string;
    full?: boolean;
}): Plan;
/** Resolve refs first, then pass only immutable IDs to subsequent Git operations. */
export declare function resolveCommit(root: string, ref: string): string;
export declare function gitTreeDigest(root: string, ref: string): string;
export declare function planRepository(root: string, config: unknown, baseRef: string, headRef: string, full?: boolean): Plan;
export interface EvidenceReceipt {
    repository: string;
    workflowId: number;
    runId: number;
    runAttempt: number;
    headSha: string;
    testedSha: string;
    lane: string;
    treeDigest: string;
    configDigest: string;
    environmentDigest: string;
    obligations: readonly string[];
}
/** These facts MUST come from authenticated GitHub reads, not from the receipt. */
export interface VerifiedProducer {
    repository: string;
    workflowId: number;
    runId: number;
    runAttempt: number;
    headSha: string;
    testedSha: string;
    latestCompletedRunId: number;
    conclusion: string;
    laneConclusions: Readonly<Record<string, string>>;
    trustedWorkflow: boolean;
    trustedReceipt: boolean;
}
export type ReuseDecision = {
    kind: 'reuse';
    sourceRun: number;
    sourceAttempt: number;
} | {
    kind: 'execute';
    reason: string;
};
/** Pure decision only. No API mutation, cancellation, cache write, or check relabeling. */
export declare function decideReuse(receipt: EvidenceReceipt, producer: VerifiedProducer, candidate: {
    repository: string;
    workflowId: number;
    headSha: string;
    lane: string;
    treeDigest: string;
    configDigest: string;
    environmentDigest: string;
    obligations: readonly string[];
}): ReuseDecision;
export declare function requireLaneResults(plan: Pick<Plan, 'lanes'>, results: Readonly<Record<string, readonly string[]>>): void;
/** Promotion requires an exact tested source and environment-bound build identity. */
export declare function requirePromotion(input: {
    sourceSha: string;
    currentMainSha: string;
    testedSha: string;
    artifactDigest: string;
    expectedArtifactDigest: string;
    environment: string;
    expectedEnvironment: string;
    requiredChecks: Readonly<Record<string, string>>;
}): void;
export {};
