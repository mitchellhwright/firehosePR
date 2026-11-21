/**
 * Build the iOS app for the simulator.
 *
 * Usage: node scripts/ios-build.ts
 *
 * The destination is the generic simulator platform, so the build needs only
 * Xcode, not a particular simulator or runtime.
 */
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const projectPath = path.join(scriptDirectory, '..', 'ios', 'example-ios.xcodeproj');
if (!existsSync(projectPath)) {
  console.error(`Xcode project not found at ${projectPath}`);
  process.exit(1);
}

const result = spawnSync('xcodebuild', [
  '-project', projectPath,
  '-scheme', 'example-ios',
  '-destination', 'generic/platform=iOS Simulator',
  'build',
], { stdio: 'inherit' });
if (result.error) {
  console.error(`Could not run xcodebuild: ${result.error.message}`);
  process.exit(1);
}
process.exitCode = result.status ?? 1;
