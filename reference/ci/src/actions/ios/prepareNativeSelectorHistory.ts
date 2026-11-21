import { z } from 'zod';
import { githubGitEnvironment } from '../../githubGit.ts';
import { prewarmNativeSelectorBlobs, resolveSelectorMergeBase } from './prewarmNativeSelectorBlobs.ts';

const commitSha = z.string().regex(/^[0-9a-f]{40}$/);

/**
 * `promotion` fetches and proves the divergent main base before selection.
 * `checkout` uses the exact-head checkout's history, fetching the base
 * ancestry only when that history does not reach it. Both then fill in the
 * blobs the credential-less selector will read.
 */
const environment = z.discriminatedUnion('IOS_SELECTOR_HISTORY', [
  z.object({ IOS_SELECTOR_HISTORY: z.literal('promotion'), IOS_AFFECTED_TESTS_BASE: commitSha }),
  z.object({ IOS_SELECTOR_HISTORY: z.literal('checkout'), IOS_AFFECTED_TESTS_BASE: commitSha.or(z.literal('')) }),
]).and(z.object({
  GITHUB_REPOSITORY: z.string().regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/),
  GITHUB_TOKEN: z.string().min(1),
  GITHUB_WORKSPACE: z.string().min(1),
  IOS_AFFECTED_TESTS_HEAD: commitSha,
})).parse(process.env);

const cwd = environment.GITHUB_WORKSPACE;
const head = environment.IOS_AFFECTED_TESTS_HEAD;
const gitEnvironment = githubGitEnvironment(environment.GITHUB_TOKEN);

const mergeBase = resolveSelectorMergeBase({
  history: environment.IOS_SELECTOR_HISTORY,
  baseSha: environment.IOS_AFFECTED_TESTS_BASE,
  headSha: head,
  remote: `https://github.com/${environment.GITHUB_REPOSITORY}.git`,
  cwd,
  env: gitEnvironment,
});
if (mergeBase === null) {
  console.log('iOS selector history: this event has no base revision, so the selector compares '
    + 'no merge-base content and there is nothing to prewarm.');
} else {
  prewarmNativeSelectorBlobs({ mergeBaseSha: mergeBase, headSha: head, cwd, env: gitEnvironment });
  console.log(`iOS selector history: merge base ${mergeBase}; selector blobs are local.`);
}
