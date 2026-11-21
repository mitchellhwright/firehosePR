import { iosGateOutput, iosGateOutputPath } from '../workflows/ios-tests/shared.ts';

iosGateOutput('verifier_sha');
iosGateOutputPath('verifier_sha');

// @ts-expect-error Only outputs declared by the iOS gate can be consumed.
iosGateOutput('verifer_sha');

// @ts-expect-error Raw expression paths must use a declared gate output.
iosGateOutputPath('verifer_sha');
