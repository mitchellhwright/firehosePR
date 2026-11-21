import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { resolveExecutable, runCommand } from './processRunner.js';
const headPattern = /^[0-9a-f]{40}$/;
const versionPattern = /^[0-9]+(?:\.[0-9]+)+$/;
const buildPattern = /^[A-Za-z0-9]+$/;
const receiptKeys = ['schemaVersion', 'headSha', 'xcodeVersion', 'xcodeBuild'];
function validateHead(head) {
    if (!headPattern.test(head))
        throw new Error('test-product head must be a lowercase 40-character SHA');
}
export function parseSelectedXcodeToolchain(output) {
    const lines = output.trim().split(/\r?\n/);
    const version = lines[0]?.startsWith('Xcode ') ? lines[0].slice(6) : '';
    const build = lines[1]?.startsWith('Build version ') ? lines[1].slice(14) : '';
    if (lines.length !== 2 || !versionPattern.test(version) || !buildPattern.test(build)) {
        throw new Error('xcodebuild returned an invalid exact toolchain');
    }
    return { xcodeVersion: version, xcodeBuild: build };
}
export async function currentTestProductToolchain() {
    const developerDirectory = process.env.DEVELOPER_DIR;
    const executable = developerDirectory
        ? join(developerDirectory, 'usr/bin/xcodebuild') : resolveExecutable('xcodebuild');
    if (executable === undefined)
        throw new Error('xcodebuild is unavailable');
    const result = await runCommand(executable, ['-version'], { capture: true, timeoutMs: 30_000 });
    if (result.status !== 0)
        throw new Error(`xcodebuild version receipt failed with status ${result.status}`);
    return parseSelectedXcodeToolchain(result.stdout);
}
export function parseTestProductToolchainReceipt(payload, expectedHead) {
    validateHead(expectedHead);
    if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) {
        throw new Error('test-product toolchain manifest has an invalid shape');
    }
    const receipt = payload;
    if (Object.keys(receipt).length !== receiptKeys.length
        || receiptKeys.some(key => !Object.hasOwn(receipt, key))) {
        throw new Error('test-product toolchain manifest has an invalid shape');
    }
    if (receipt.schemaVersion !== 1 || receipt.headSha !== expectedHead) {
        throw new Error('test-product toolchain manifest does not match its producer revision');
    }
    if (typeof receipt.xcodeVersion !== 'string' || !versionPattern.test(receipt.xcodeVersion)
        || typeof receipt.xcodeBuild !== 'string' || !buildPattern.test(receipt.xcodeBuild)) {
        throw new Error('test-product toolchain manifest has an invalid exact toolchain');
    }
    return { schemaVersion: 1, headSha: expectedHead, xcodeVersion: receipt.xcodeVersion, xcodeBuild: receipt.xcodeBuild };
}
export function readTestProductToolchainReceipt(path, expectedHead) {
    let payload;
    try {
        payload = JSON.parse(readFileSync(path, 'utf8'));
    }
    catch {
        throw new Error('test-product toolchain manifest is unreadable');
    }
    return parseTestProductToolchainReceipt(payload, expectedHead);
}
export async function writeTestProductToolchainReceipt(path, head) {
    validateHead(head);
    const toolchain = await currentTestProductToolchain();
    mkdirSync(dirname(path), { recursive: true });
    // Keep the v1 wire contract: existing sealed archives remain readable.
    const receipt = { schemaVersion: 1, headSha: head, ...toolchain };
    writeFileSync(path, `${JSON.stringify(receipt)}\n`, 'utf8');
    console.log(`Recorded producer toolchain Xcode ${toolchain.xcodeVersion} (${toolchain.xcodeBuild})`);
}
/** Only a valid receipt for another exact Xcode requests a rebuild (status 3).
 * Unreadable, malformed and wrong-head receipts throw; consumers fail closed. */
export async function verifyTestProductToolchainReceipt(path, head) {
    const receipt = readTestProductToolchainReceipt(path, head);
    const selected = await currentTestProductToolchain();
    if (selected.xcodeVersion !== receipt.xcodeVersion || selected.xcodeBuild !== receipt.xcodeBuild) {
        console.error(`Producer used Xcode ${receipt.xcodeVersion} (${receipt.xcodeBuild}); consumer selected Xcode ${selected.xcodeVersion} (${selected.xcodeBuild}).`);
        return 3;
    }
    console.log(`Precompiled products match consumer Xcode ${selected.xcodeVersion} (${selected.xcodeBuild})`);
    return 0;
}
