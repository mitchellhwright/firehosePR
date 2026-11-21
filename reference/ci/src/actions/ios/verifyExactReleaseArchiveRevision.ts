import { macRevisionAdmission } from '../../ios/macRevisionAdmission.ts';
import { runAsyncStepProgram } from '../../ios/shared/stepDecision.ts';

// This entry must run from the gate-proven verifier checkout, never PR-head CI code.
await runAsyncStepProgram('Exact Release archive revision', () => macRevisionAdmission(import.meta.url));
