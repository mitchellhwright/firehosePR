/** Exact producer receipt shared by native and real-server test-product handoffs. */
export interface TestProductToolchainReceipt {
    readonly schemaVersion: 1;
    readonly headSha: string;
    readonly xcodeVersion: string;
    readonly xcodeBuild: string;
}
export interface SelectedXcodeToolchain {
    readonly xcodeVersion: string;
    readonly xcodeBuild: string;
}
export declare function parseSelectedXcodeToolchain(output: string): SelectedXcodeToolchain;
export declare function currentTestProductToolchain(): Promise<SelectedXcodeToolchain>;
export declare function parseTestProductToolchainReceipt(payload: unknown, expectedHead: string): TestProductToolchainReceipt;
export declare function readTestProductToolchainReceipt(path: string, expectedHead: string): TestProductToolchainReceipt;
export declare function writeTestProductToolchainReceipt(path: string, head: string): Promise<void>;
/** Only a valid receipt for another exact Xcode requests a rebuild (status 3).
 * Unreadable, malformed and wrong-head receipts throw; consumers fail closed. */
export declare function verifyTestProductToolchainReceipt(path: string, head: string): Promise<0 | 3>;
