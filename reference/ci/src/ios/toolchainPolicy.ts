/**
 * The one Xcode build every iOS lane and the Mac readiness audit compile with.
 *
 * Swift warnings are errors in CI, and each Xcode release adds diagnostics, so
 * a runner that quietly upgrades Xcode would change what CI reports. A runner
 * without this exact build fails the Xcode selection step instead of building
 * with whatever it has. Changing the pin is a reviewed edit here, together with
 * the matching SDK and runtime profile in scripts/ios-ci-image-prerequisites.py.
 */
export type XcodeToolchainSpec = `${number}.${number}@${string}`;

export const pinnedIosXcodeToolchain: XcodeToolchainSpec = '27.0@27A266a';

export type IosRuntimeVersion = `${number}.${number}`;

/**
 * The iOS simulator runtime every simulator lane tests on. Its build is
 * pinned beside it in scripts/ios-ci-image-prerequisites.py, which verifies
 * both on the runner; a test keeps the two versions equal.
 */
export const pinnedIosSimulatorRuntime: IosRuntimeVersion = '27.0';

/** The CoreSimulator identifier of the pinned runtime, for steps that address it by identifier. */
export const pinnedIosSimulatorRuntimeIdentifier = 'com.apple.CoreSimulator.SimRuntime.iOS-27-0';
