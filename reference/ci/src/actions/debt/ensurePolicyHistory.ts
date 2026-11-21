import { runCommand } from '../../ios/shared/processRunner.ts';

interface FetchCredential {
  readonly token: string;
  readonly serverUrl: string;
  readonly repository: string;
}

async function git(args: readonly string[], cwd: string, env?: NodeJS.ProcessEnv): Promise<string> {
  const result = await runCommand('git', args, { cwd, env, capture: true });
  if (result.status !== 0) {
    throw new Error(`git ${args[0]} failed: ${result.stderr.trim() || result.stdout.trim()}`);
  }
  return result.stdout.trim();
}

/** Fetch only the checked candidate's ancestry, not every branch and tag. */
export async function ensurePolicyHistory(cwd: string, credential?: FetchCredential): Promise<void> {
  if (await git(['rev-parse', '--is-shallow-repository'], cwd) !== 'true') return;
  const target = await git(['rev-parse', 'HEAD'], cwd);
  const remote = await git(['remote', 'get-url', 'origin'], cwd);
  let env: NodeJS.ProcessEnv | undefined;
  if (credential !== undefined) {
    const { token, serverUrl, repository } = credential;
    if (!token || !/^https:\/\/[^/]+$/.test(serverUrl)
      || !/^[\w.-]+\/[\w.-]+$/.test(repository)
      || ![`${serverUrl}/${repository}`, `${serverUrl}/${repository}.git`].includes(remote)) {
      throw new Error('Policy history remote or GitHub credential is invalid');
    }
    env = {
      ...process.env,
      GIT_CONFIG_COUNT: '1',
      GIT_CONFIG_KEY_0: `http.${serverUrl}/.extraheader`,
      GIT_CONFIG_VALUE_0: `AUTHORIZATION: basic ${Buffer.from(`x-access-token:${token}`).toString('base64')}`,
    };
  }
  await git(['fetch', '--no-tags', '--unshallow', 'origin', target], cwd, env);
  if (await git(['rev-parse', '--is-shallow-repository'], cwd) !== 'false'
    || await git(['rev-parse', 'HEAD'], cwd) !== target) {
    throw new Error('Policy history fetch did not preserve the checked candidate');
  }
}
