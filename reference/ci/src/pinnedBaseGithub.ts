import { setTimeout } from 'node:timers/promises';
import { z } from 'zod';
import { publishPinnedBaseUpdate, type NativeResponse, type PinnedBaseUpdate } from './pinnedBaseUpdate.ts';

/** Shared native API transport; no repository token is put in a URL or log. */
export function createPinnedBaseGithubClient(config: {
  readonly repository: string; readonly readToken: string; readonly updateToken: string;
}, fetchImpl: typeof fetch = fetch, wait: () => Promise<void> = () => setTimeout(5000)) {
  const repository = z.string().regex(/^[\w.-]+\/[\w.-]+$/).parse(config.repository);
  const request = async (path: string, options?: { readonly method: string; readonly body: unknown }): Promise<NativeResponse> => {
    const url = path === 'graphql' ? 'https://api.github.com/graphql'
      : `https://api.github.com/repos/${repository}${path ? `/${path}` : ''}`;
    const response = await fetchImpl(url, {
      method: options?.method ?? 'GET',
      headers: {
        Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28',
        Authorization: `Bearer ${options ? config.updateToken : config.readToken}`,
        'Content-Type': 'application/json',
      },
      ...(options ? { body: JSON.stringify(options.body) } : {}),
      signal: AbortSignal.timeout(30_000),
    });
    return { status: response.status, body: await response.json() as unknown };
  };
  let repositoryId: string | undefined;
  return {
    read: (path: string) => request(path),
    update: async (input: PinnedBaseUpdate, stillCurrent: () => Promise<boolean>) => {
      if (!repositoryId) {
        const identity = await request('');
        if (identity.status !== 200) throw new Error(`Cannot read repository identity: HTTP ${identity.status}`);
        repositoryId = z.object({ node_id: z.string().min(1) }).parse(identity.body).node_id;
      }
      return publishPinnedBaseUpdate(input, {
        read: path => request(path),
        createCommit: body => request('git/commits', { method: 'POST', body }),
        publish: update => request('graphql', { method: 'POST', body: {
          query: 'mutation($input:UpdateRefsInput!){updateRefs(input:$input){clientMutationId}}',
          variables: { input: { repositoryId, refUpdates: [update] } },
        } }),
        wait,
      }, stillCurrent);
    },
  };
}
