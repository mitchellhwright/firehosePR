/** A class's test methods as the Swift sources declare them. */
export interface UiTestSourceInventory {
    /** The union of `func test…(` names over every declaration of the class. */
    readonly methods: ReadonlyMap<string, ReadonlySet<string>>;
    /** The largest method count of any single declaration of the class (at least 1). */
    readonly weights: ReadonlyMap<string, number>;
}
export interface UiTestPartitionInput {
    /** The `.xctestplan` JSON text. */
    readonly testPlan: string;
    /** The duration hints JSON text: `{ classes: {...}, tests: {...} }`. */
    readonly durationHints: string;
    readonly sources: UiTestSourceInventory;
    readonly target: string;
    /** `TARGET/Class` or `TARGET/Class/method` identifiers kept out of every shard. */
    readonly exclusions: readonly string[];
    readonly shardCount: number;
}
export interface UiTestPartition {
    /** Each shard's `TARGET/Class/method` identifiers, sorted. */
    readonly shards: readonly (readonly string[])[];
    readonly estimatedSeconds: readonly number[];
    readonly selectedCount: number;
}
/** Reads every `.swift` file under `sourceRoot` into a class → methods inventory. */
export declare function readUiTestSources(sourceRoot: string): UiTestSourceInventory;
/** Partitions the target's selected UI tests into `shardCount` duration-balanced shards. */
export declare function partitionUiTests(input: UiTestPartitionInput): UiTestPartition;
export interface UiTestPartitionFiles {
    readonly testPlanPath: string;
    readonly sourceRoot: string;
    readonly durationHintsPath: string;
    readonly target: string;
    readonly exclusionsPath?: string;
    readonly shardCount: number;
}
/** Reads the plan, sources, hints and optional exclusion list from disk, then partitions. */
export declare function partitionUiTestFiles(files: UiTestPartitionFiles): UiTestPartition;
