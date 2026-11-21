import { appendStepSummary, requiredEnv } from '../ios/shared/actionIo.ts';

appendStepSummary('## Promotion checkpoint created');
appendStepSummary('');
appendStepSummary(`- PR: [#${requiredEnv('CHECKPOINT_PR_NUMBER')}](${requiredEnv('CHECKPOINT_URL')})`);
appendStepSummary(`- Branch: \`${requiredEnv('CHECKPOINT_BRANCH')}\``);
appendStepSummary(`- Source commit: \`${requiredEnv('HEAD_SHA')}\``);
appendStepSummary(`- Proven checkpoint head: \`${requiredEnv('CHECKPOINT_HEAD')}\``);
appendStepSummary(`- Proven current main: \`${requiredEnv('CHECKPOINT_BASE')}\``);
