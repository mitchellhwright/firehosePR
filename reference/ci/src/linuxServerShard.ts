/** One execution contract shared by native workflow authoring and receipt production. */
export const linuxServerShardIds = [1, 2, 3, 4] as const;
export function linuxServerShardCommand(shard: string | number): string {
  return `node ci/src/actions/runLinuxCoverageShard.ts ${shard}`;
}
