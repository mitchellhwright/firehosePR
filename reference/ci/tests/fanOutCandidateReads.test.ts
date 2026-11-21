import assert from 'node:assert/strict';
import { it } from 'node:test';
import { readFanOutCandidates } from '../src/fanOutCandidateReads.ts';

it('keeps deterministic inventory despite reversed completion and admits the next batch only after draining', async () => {
  const started: number[] = [];
  const completed: number[] = [];
  const releases = new Map<number, (value: number) => void>();
  const inventory = readFanOutCandidates([0, 1, 2, 3, 4], async item => {
    started.push(item);
    const value = await new Promise<number>(resolve => releases.set(item, resolve));
    completed.push(item);
    return value;
  });
  assert.deepEqual(started, [0, 1, 2, 3]);
  for (const item of [3, 2, 1]) releases.get(item)?.(item);
  await new Promise<void>(resolve => setImmediate(resolve));
  assert.deepEqual(started, [0, 1, 2, 3], 'an unfinished read keeps the next batch unadmitted');
  releases.get(0)?.(0);
  await new Promise<void>(resolve => setImmediate(resolve));
  assert.deepEqual(started, [0, 1, 2, 3, 4]);
  releases.get(4)?.(4);
  assert.deepEqual(await inventory, [0, 1, 2, 3, 4]);
  assert.deepEqual(completed, [3, 2, 1, 0, 4]);
});

it('drains every admitted read and refuses a partial inventory or further reads after failure', async () => {
  const failure = new Error('unverified candidate metadata');
  let release: (() => void) | undefined;
  const started: number[] = [];
  const inventory = readFanOutCandidates([0, 1, 2, 3, 4], async item => {
    started.push(item);
    if (item === 1) throw failure;
    if (item === 3) await new Promise<void>(resolve => { release = resolve; });
    return item;
  });
  let finished = false;
  const checked = assert.rejects(inventory, error => error === failure).then(() => { finished = true; });
  await new Promise<void>(resolve => setImmediate(resolve));
  assert.equal(finished, false);
  assert.deepEqual(started, [0, 1, 2, 3]);
  assert.ok(release); release();
  await checked;
  assert.deepEqual(started, [0, 1, 2, 3]);
});

it('an empty inventory performs no metadata reads', async () => {
  assert.deepEqual(await readFanOutCandidates([], async () => { throw new Error('unexpected read'); }), []);
});

it('captures synchronous reader failure while draining other admitted reads', async () => {
  const failure = new Error('synchronous metadata failure');
  let release: (() => void) | undefined;
  const started: number[] = [];
  const inventory = readFanOutCandidates([0, 1, 2, 3, 4], item => {
    started.push(item);
    if (item === 1) throw failure;
    if (item === 3) return new Promise<number>(resolve => { release = () => resolve(item); });
    return Promise.resolve(item);
  });
  let finished = false;
  const checked = assert.rejects(inventory, error => error === failure).then(() => { finished = true; });
  await new Promise<void>(resolve => setImmediate(resolve));
  assert.equal(finished, false);
  assert.deepEqual(started, [0, 1, 2, 3]);
  assert.ok(release); release();
  await checked;
  assert.deepEqual(started, [0, 1, 2, 3]);
});
