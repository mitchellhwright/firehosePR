/** Paths that cannot change the web image or the develop deployment pipeline. */
const nonDeployDirectories = [
  'ios',
  '.github',
  'ci/contracts',
  'ci/scripts',
  'ci/src',
  'ci/tests',
  'ci/workflows',
] as const;

const nonDeployFiles = [
  'ci/package.json',
  'ci/package-lock.json',
  'ci/tsconfig.json',
  'ci/tsconfig.scripts.json',
] as const;

/** Cloud Build applies these globs before it creates a build on a branch push. */
export const webDeployIgnoredFiles = [
  ...nonDeployDirectories.map((directory) => `${directory}/**` as const),
  ...nonDeployFiles,
] as const;

export const webDeployIgnoredFilesPath = 'terraform/platform/generated-cloud-build-ignored-files.json';

export function renderWebDeployIgnoredFiles(): string {
  return `${JSON.stringify(webDeployIgnoredFiles, null, 2)}\n`;
}
