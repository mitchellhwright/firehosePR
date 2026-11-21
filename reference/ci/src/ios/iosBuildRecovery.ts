/**
 * Which failures `scripts/run-with-ios-cache-recovery.sh` may retry once, and
 * what it repairs first. Only an environment fault qualifies; a failure the
 * head under review caused must fail the lane on its first attempt.
 */

export type IosRecoveryKind =
  | 'cache corruption'
  | 'CoreSimulator infrastructure'
  | 'Plaid sandbox infrastructure';

/** SwiftPM or build-system state in the persistent cache that no source change explains. */
const CACHE_CORRUPTION = new RegExp([
  String.raw`workspace-state\.json.*(corrupt|malformed|invalid)`,
  String.raw`checksum of downloaded artifact.*does not match`,
  String.raw`PIF transfer session.*(failed|invalid)`,
  String.raw`package graph.*(corrupt|invalid)`,
  String.raw`unable to open dependencies file.*\.d\)`,
].join('|'), 'i');

/**
 * The linker cannot find a symbol of the app module itself. The compiler
 * accepted every reference to it, so an object file was compiled against a
 * declaration this revision does not have: a stale object in the cache. The
 * cache's interruption guard prevents the known cause; this recovers a cache
 * that was already in that state, or one reached some other way.
 */
const STALE_APP_OBJECT =
  /Undefined symbols for architecture [^\n]*:\n(?:[ \t]+[^\n]*\n)*?[ \t]+"(?:example_ios\.|_\$s8example_ios)/;

const CORE_SIMULATOR = new RegExp([
  String.raw`NSMachErrorDomain\P{Cc}*-308`,
  String.raw`CoreSimulatorService\P{Cc}*(died|invalid|unavailable|connection)`,
  String.raw`Failed to boot simulator because the service is unavailable`,
].join('|'), 'iu');

const PLAID_SANDBOX =
  /Plaid\P{Cc}*(sandbox sync|Sandbox)\P{Cc}*(timed out|timeout|never reached a healthy state)/iu;

/** The recovery a failed command's log qualifies for, in priority order, or none. */
export function classifyIosRecovery(log: string): IosRecoveryKind | undefined {
  const text = log.replaceAll('\r\n', '\n');
  if (CACHE_CORRUPTION.test(text) || STALE_APP_OBJECT.test(text)) return 'cache corruption';
  if (CORE_SIMULATOR.test(text)) return 'CoreSimulator infrastructure';
  if (PLAID_SANDBOX.test(text)) return 'Plaid sandbox infrastructure';
  return undefined;
}
