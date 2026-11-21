/**
 * Decides whether a package.json change can alter what the server suite
 * exercises. Most CI-only pull requests touch package.json to add or rename an
 * `npm run` script, and running four server test lanes plus a database for
 * that costs more runner time than the rest of the pull request combined.
 *
 * The decision is fail-closed: only the keys listed here are known not to
 * reach runtime, so a change to any other key (dependencies, overrides,
 * engines, exports, a key npm adds next year) still selects the full suite.
 */
export const runtimeNeutralManifestKeys: ReadonlySet<string> = new Set([
  'author',
  'bugs',
  'description',
  'homepage',
  'keywords',
  'license',
  'lint-staged',
  'name',
  'private',
  'repository',
  'scripts',
  'version',
]);

function manifestObject(source: string): Record<string, unknown> | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(source);
  } catch {
    return null;
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
  return parsed as Record<string, unknown>;
}

function canonical(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>).sort(([left], [right]) => left.localeCompare(right));
  return `{${entries.map(([key, entry]) => `${JSON.stringify(key)}:${canonical(entry)}`).join(',')}}`;
}

/**
 * True when every key that differs between the two manifests is runtime
 * neutral. Unparseable input, a non-object manifest, or a missing side is a
 * change that cannot be reasoned about and therefore is not neutral.
 */
export function manifestChangeIsRuntimeNeutral(base: string | null, head: string | null): boolean {
  if (base === null || head === null) return false;
  const baseManifest = manifestObject(base);
  const headManifest = manifestObject(head);
  if (baseManifest === null || headManifest === null) return false;
  const keys = new Set([...Object.keys(baseManifest), ...Object.keys(headManifest)]);
  for (const key of keys) {
    if (runtimeNeutralManifestKeys.has(key)) continue;
    if (canonical(baseManifest[key]) !== canonical(headManifest[key])) return false;
  }
  return true;
}

/** A changed npm alias that invokes a required acceptance lane must rerun it. */
export function manifestScriptChanged(
  base: string | null,
  head: string | null,
  script: string,
): boolean {
  const baseManifest = base === null ? null : manifestObject(base);
  const headManifest = head === null ? null : manifestObject(head);
  if (baseManifest === null || headManifest === null) return true;
  const baseScripts = baseManifest.scripts;
  const headScripts = headManifest.scripts;
  if (baseScripts === null || typeof baseScripts !== 'object' || Array.isArray(baseScripts)
      || headScripts === null || typeof headScripts !== 'object' || Array.isArray(headScripts)) {
    return true;
  }
  return canonical((baseScripts as Record<string, unknown>)[script])
    !== canonical((headScripts as Record<string, unknown>)[script]);
}

/** How a package.json change reaches the lanes that run npm scripts or the server runtime. */
export interface PackageManifestLaneImpact {
  readonly runtimeNeutral: boolean;
  readonly entitlementAcceptanceScriptChanged: boolean;
}

/**
 * Classifies a package.json change by comparing the trusted base with the pull
 * request head. A head routed by its base delta reuses evidence produced on the
 * prior base, whose manifest is not the one compared here: when the base
 * update itself changed package.json, base and head can agree while a script
 * or dependency still differs from what the reused run exercised. That change
 * is never neutral and reruns every script-driven lane, entitlement
 * acceptance included.
 */
export function packageManifestLaneImpact({ base, head, manifestChanged, baseDeltaRoute }: {
  readonly base: string | null;
  readonly head: string | null;
  readonly manifestChanged: boolean;
  readonly baseDeltaRoute: boolean;
}): PackageManifestLaneImpact {
  if (manifestChanged && baseDeltaRoute) {
    return { runtimeNeutral: false, entitlementAcceptanceScriptChanged: true };
  }
  return {
    runtimeNeutral: manifestChangeIsRuntimeNeutral(base, head),
    entitlementAcceptanceScriptChanged: manifestChanged
      && manifestScriptChanged(base, head, 'test:entitlements:db'),
  };
}
