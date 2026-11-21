/** The sole API adapter for asking GitHub to arm native squash auto-merge. */
function record(value: unknown): Readonly<Record<string, unknown>> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Readonly<Record<string, unknown>> : null;
}

export async function githubRest(path: string): Promise<unknown> {
  const repository = process.env.GITHUB_REPOSITORY;
  const token = process.env.GITHUB_TOKEN;
  if (!repository || !token) throw new Error('GitHub repository and token are required');
  const response = await fetch(`${process.env.GITHUB_API_URL ?? 'https://api.github.com'}/repos/${repository}/${path}`, {
    headers: { Accept: 'application/vnd.github+json', Authorization: `Bearer ${token}`, 'X-GitHub-Api-Version': '2022-11-28' },
  });
  if (!response.ok) throw new Error(`GitHub REST ${path}: ${response.status}`);
  return response.json() as Promise<unknown>;
}

/** A missing collaborator has no permission; other API failures must stop the job. */
export async function githubAuthorPermission(login: string): Promise<unknown> {
  const repository = process.env.GITHUB_REPOSITORY;
  const token = process.env.GITHUB_TOKEN;
  if (!repository || !token) throw new Error('GitHub repository and token are required');
  const response = await fetch(`${process.env.GITHUB_API_URL ?? 'https://api.github.com'}`
    + `/repos/${repository}/collaborators/${encodeURIComponent(login)}/permission`, {
    headers: { Accept: 'application/vnd.github+json', Authorization: `Bearer ${token}`, 'X-GitHub-Api-Version': '2022-11-28' },
  });
  if (response.status === 404) return null;
  if (!response.ok) throw new Error(`GitHub author permission: ${response.status}`);
  return response.json() as Promise<unknown>;
}

/** A queue may accept the request without retaining an autoMergeRequest. */
export function autoMergeConfirmed(body: unknown): boolean {
  const root = record(body);
  if (root?.errors != null) return false;
  const pullRequest = record(record(record(root?.data)?.enablePullRequestAutoMerge)?.pullRequest);
  return record(pullRequest?.autoMergeRequest)?.mergeMethod === 'SQUASH' || pullRequest?.isInMergeQueue === true;
}

export async function githubEnable(nodeId: string): Promise<void> {
  const token = process.env.GITHUB_TOKEN;
  if (!token) throw new Error('GitHub token is required');
  const response = await fetch(process.env.GITHUB_GRAPHQL_URL ?? 'https://api.github.com/graphql', {
    method: 'POST',
    headers: { Accept: 'application/vnd.github+json', Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      query: 'mutation($id:ID!) { enablePullRequestAutoMerge(input:{pullRequestId:$id,mergeMethod:SQUASH}) { pullRequest { autoMergeRequest { mergeMethod } isInMergeQueue } } }',
      variables: { id: nodeId },
    }),
  });
  const body: unknown = await response.json();
  if (!response.ok || !autoMergeConfirmed(body)) {
    throw new Error(`GitHub did not confirm squash auto-merge or merge queue entry (${response.status})`);
  }
}
