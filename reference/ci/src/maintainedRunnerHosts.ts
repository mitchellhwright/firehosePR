/**
 * The durable self-hosted runner hosts whose completed-job cleanup hook the
 * fleet maintains. The fleet dispatcher asks each host to reinstall its hook,
 * and the activation-complete job admits only these hosts, so both read this
 * one list.
 *
 * A host label names one listener: `ios-host-tg1` is a second listener on the
 * same Mac as `ios-host-sagent`, and each listener carries its own hook.
 */
export const maintainedRunnerHosts = [
  { hostLabel: 'ios-host-mitchell', platform: 'macos' },
  { hostLabel: 'ios-host-ottavio', platform: 'macos' },
  { hostLabel: 'ios-host-sagaris', platform: 'macos' },
  { hostLabel: 'ios-host-sagent', platform: 'macos' },
  { hostLabel: 'ios-host-tg1', platform: 'macos' },
  { hostLabel: 'host-instaip', platform: 'linux' },
  { hostLabel: 'host-instaip2', platform: 'linux' },
] as const satisfies readonly { readonly hostLabel: string; readonly platform: 'macos' | 'linux' }[];

export type MaintainedRunnerHost = (typeof maintainedRunnerHosts)[number];
export type MaintainedHostLabel = MaintainedRunnerHost['hostLabel'];

export const maintainedHostLabels: readonly MaintainedHostLabel[] =
  maintainedRunnerHosts.map((host) => host.hostLabel);
