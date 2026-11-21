interface GuardedCommand {
    readonly derivedData: string;
    readonly command: string;
    readonly args: readonly string[];
}
export declare function parseGuardArguments(argv: readonly string[]): GuardedCommand;
export declare function guardIosIncrementalBuild(argv: readonly string[]): Promise<number>;
export {};
