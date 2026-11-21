import { renderAssuranceSummary } from '../prGateAdapters.ts';
import { appendStepSummary, optionalEnv, booleanEnv } from '../ios/shared/actionIo.ts';

appendStepSummary(renderAssuranceSummary({
  mode: optionalEnv('ASSURANCE_MODE', 'skip'),
  selectedPackages: JSON.parse(optionalEnv('ASSURANCE_PACKAGES', '[]')) as unknown,
  gaps: JSON.parse(optionalEnv('ASSURANCE_GAPS', '[]')) as unknown,
  independentAuditRequired: booleanEnv('INDEPENDENT_AUDIT_REQUIRED'),
}));
