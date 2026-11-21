/** GitHub Git credentials are subprocess environment values, never argv or files. */
export function githubGitEnvironment(token: string): NodeJS.ProcessEnv {
  if (!token) throw new Error('No Git credential available.');
  return {
    ...process.env,
    GIT_TERMINAL_PROMPT: '0',
    GIT_CONFIG_COUNT: '3',
    GIT_CONFIG_KEY_0: 'credential.helper',
    GIT_CONFIG_VALUE_0: '',
    GIT_CONFIG_KEY_1: 'http.https://github.com/.extraheader',
    GIT_CONFIG_VALUE_1: '',
    GIT_CONFIG_KEY_2: 'http.https://github.com/.extraheader',
    GIT_CONFIG_VALUE_2: `AUTHORIZATION: basic ${Buffer.from(`x-access-token:${token}`).toString('base64')}`,
  };
}
