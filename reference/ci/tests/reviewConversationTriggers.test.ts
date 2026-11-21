import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { load } from 'js-yaml';

/**
 * Review conversations gate merging only through the rulesets' native
 * conversation-resolution rule. No workflow may react to review or comment
 * activity, so opening or resolving a thread never cancels, skips or reruns
 * CI for an unchanged head.
 */

const WORKFLOW_DIRECTORY = '.github/workflows';
const REVIEW_CONVERSATION_EVENTS: readonly string[] = [
  'issue_comment',
  'pull_request_review',
  'pull_request_review_comment',
  'pull_request_review_thread',
];

function triggerNames(on: unknown): readonly string[] {
  if (typeof on === 'string') return [on];
  if (Array.isArray(on)) return on.map(String);
  if (on !== null && typeof on === 'object') return Object.keys(on);
  throw new Error(`Workflow trigger must be a string, list or mapping, got ${JSON.stringify(on)}.`);
}

function reviewConversationTriggers(source: string): readonly string[] {
  const document = load(source) as { readonly on?: unknown } | null;
  if (document === null || !('on' in document)) throw new Error('Workflow has no "on" trigger.');
  return triggerNames(document.on).filter(name => REVIEW_CONVERSATION_EVENTS.includes(name));
}

test('no workflow subscribes to review or comment events', () => {
  const files = readdirSync(WORKFLOW_DIRECTORY).filter(name => /\.ya?ml$/.test(name));
  assert.ok(files.length > 0, `expected workflows in ${WORKFLOW_DIRECTORY}`);
  const offenders = files.flatMap(file => reviewConversationTriggers(
    readFileSync(join(WORKFLOW_DIRECTORY, file), 'utf8'),
  ).map(event => `${file}: ${event}`));
  assert.deepEqual(offenders, []);
});

test('review trigger detection covers every trigger shape', () => {
  assert.deepEqual(reviewConversationTriggers('on: pull_request_review_thread\n'),
    ['pull_request_review_thread']);
  assert.deepEqual(reviewConversationTriggers('on: [push, issue_comment]\n'), ['issue_comment']);
  assert.deepEqual(reviewConversationTriggers(
    'on:\n  pull_request_target:\n    types: [closed]\n  pull_request_review:\n    types: [submitted]\n',
  ), ['pull_request_review']);
  assert.deepEqual(reviewConversationTriggers('on:\n  pull_request:\n'), []);
  assert.throws(() => reviewConversationTriggers('name: no trigger\n'), /no "on" trigger/);
});
