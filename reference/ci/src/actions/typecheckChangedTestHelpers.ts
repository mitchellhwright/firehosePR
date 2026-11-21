import { existsSync, statSync } from 'node:fs';
import { dirname, posix, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import * as ts from 'typescript';
import { z } from 'zod';

const helperPathsSchema = z.array(z.string()
  .regex(/^server\/tests\/.+\.ts$/)
  .refine((path) => posix.normalize(path) === path && !path.split('/').includes('..')));

/** Type-check only changed, graph-owned test helpers and their imports. */
export function typecheckChangedTestHelpers(
  helperPaths: readonly string[],
  configPath = resolve('tsconfig.json'),
): readonly ts.Diagnostic[] {
  const paths = helperPathsSchema.parse(helperPaths);
  if (paths.length === 0) return [];
  const root = dirname(configPath);
  const rootNames = paths.map((path) => resolve(root, path));
  for (const path of rootNames) {
    if (!existsSync(path) || !statSync(path).isFile()) {
      throw new Error(`Changed server test helper is missing: ${path}`);
    }
  }

  const config = ts.readConfigFile(configPath, ts.sys.readFile);
  if (config.error) return [config.error];
  const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, dirname(configPath));
  // A focused helper program still needs the application's ambient types.
  // Keep declaration roots from the parsed project without compiling every
  // unrelated production source file.
  const declarationRoots = parsed.fileNames.filter((fileName) => /\.d\.[cm]?ts$/.test(fileName));
  const program = ts.createProgram({
    rootNames: [...new Set([...rootNames, ...declarationRoots])],
    options: {
      ...parsed.options,
      // The root app config excludes tests, and its incremental cache is not
      // shared with this exact-head helper selection.
      incremental: false,
      tsBuildInfoFile: undefined,
      noEmit: true,
      allowImportingTsExtensions: true,
    },
  });
  return [...parsed.errors, ...ts.getPreEmitDiagnostics(program)];
}

function run(): void {
  const paths = helperPathsSchema.parse(JSON.parse(process.env['TEST_ONLY_HELPERS_JSON'] ?? '[]'));
  const diagnostics = typecheckChangedTestHelpers(paths);
  if (diagnostics.length > 0) {
    process.stderr.write(ts.formatDiagnosticsWithColorAndContext(diagnostics, {
      getCanonicalFileName: (path) => path,
      getCurrentDirectory: () => process.cwd(),
      getNewLine: () => '\n',
    }));
    process.exitCode = 1;
    return;
  }
  process.stdout.write(`Type-checked ${paths.length} changed server test helper(s).\n`);
}

if (process.argv[1] !== undefined && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  run();
}
