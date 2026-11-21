/**
 * Path ownership for generated artifacts shared by independent source edits.
 * Only directories owned entirely by generators may be classified by path.
 * The iOS Models/Generated directory also contains hand-maintained Swift,
 * so its generated files are identified by `.generated.<extension>` instead.
 */
const generatorOwnedDirectories = [
  'ci/generated/',
  'scripts/ci/generated/',
  'server/generated/',
] as const;

export function isGeneratedArtifactPath(path: string): boolean {
  return generatorOwnedDirectories.some((directory) => path.startsWith(directory))
    || /\.generated\.[^/]+$/.test(path);
}
