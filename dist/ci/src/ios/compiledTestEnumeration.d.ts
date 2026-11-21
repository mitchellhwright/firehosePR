/**
 * Xcode's flat JSON enumeration is the inventory of executable methods in a
 * compiled `.xctestproducts` bundle. Collect identifiers from the parsed JSON
 * rather than assuming a particular wrapper key across Xcode releases.
 */
export declare function compiledTestIdentifiers(document: unknown): readonly string[];
export declare function testPlanSelectors(document: unknown): readonly string[];
export interface CompiledPlanComparison {
    readonly compiledMethods: number;
    readonly matchedSelectors: number;
    readonly missingSelectors: readonly string[];
}
/** Compare the authored plan with Xcode's unfiltered executable inventory. */
export declare function compareCompiledPlan(planSelectors: readonly string[], compiledIdentifiers: readonly string[]): CompiledPlanComparison;
/** Enumerate the compiled products without the changed-file selector's filters. */
export declare function unfilteredEnumerationArguments(input: {
    readonly planName: 'CI' | 'CI-Unit' | 'CI-Evidence';
    readonly productsPath: string;
    readonly destination: string;
    readonly outputPath: string;
}): readonly string[];
