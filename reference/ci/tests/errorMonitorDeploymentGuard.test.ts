import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import test from 'node:test';

import { errorMonitorDeploymentGuardInputs } from '../src/prValidationPlan.ts';

test('the unsanitized error monitor has no executable deployment entry point', () => {
  const manifest = JSON.parse(readFileSync(errorMonitorDeploymentGuardInputs.manifest, 'utf8')) as {
    scripts?: Record<string, string>;
  };
  assert.deepEqual(manifest.scripts, {
    build: 'tsc',
    start: 'functions-framework --target=errorMonitor',
  });
  assert.equal(existsSync(errorMonitorDeploymentGuardInputs.retiredDeploy), false);
  assert.equal(existsSync(errorMonitorDeploymentGuardInputs.retiredTest), false);
});
