import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { orphanActivationMarkers } from '../src/actions/removeOrphanActivationMarkers.ts';

const marker = '{"schema":"example.runner-activation.v1","context":"x","state":"success"}\n';

function markerRoot(files: readonly string[]): string {
  const root = mkdtempSync(join(tmpdir(), 'activation-markers-'));
  for (const name of files) writeFileSync(join(root, name), marker);
  return root;
}

test('markers left by activations that never ran are orphans', () => {
  const names = [
    'example-runner-environment-ios-host-mitchell-35518336356-1.completed',
    'example-runner-environment-ios-host-mitchell-36247320485-1.completed',
  ];
  const root = markerRoot(names);
  assert.deepEqual(orphanActivationMarkers(root, 'ios-host-mitchell'),
    names.map((name) => join(root, name)));
});

test('a marker whose activation log exists waits for its completion job', () => {
  const label = 'example-runner-environment-ios-host-tg1-36246765796-1';
  const root = markerRoot([`${label}.completed`, `${label}.log`]);
  assert.deepEqual(orphanActivationMarkers(root, 'ios-host-tg1'), []);
  assert.ok(existsSync(join(root, `${label}.completed`)));
});

test('another host label, a label prefix and unrelated files are not orphans', () => {
  const root = markerRoot([
    'example-runner-environment-ios-host-sagent-36242068321-1.completed',
    'example-runner-environment-ios-host-tg10-1-1.completed',
    'job-completed.sh',
    'activate-runner-environment.sh',
  ]);
  assert.deepEqual(orphanActivationMarkers(root, 'ios-host-tg1'), []);
  assert.equal(readdirSync(root).length, 4);
});

test('a missing marker directory has no orphans', () => {
  const root = mkdtempSync(join(tmpdir(), 'activation-markers-'));
  assert.deepEqual(orphanActivationMarkers(join(root, 'absent'), 'ios-host-tg1'), []);
});

test('an unsafe host label is rejected', () => {
  const root = markerRoot(['example-runner-environment-x-1-1.completed']);
  assert.throws(() => orphanActivationMarkers(root, '.*'), /Unsafe durable host label/);
});
