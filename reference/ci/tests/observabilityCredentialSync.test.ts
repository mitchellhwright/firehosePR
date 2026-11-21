import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import { load } from 'js-yaml';

import {
  encodeSecretPayload,
  secretVersionFailure,
  secretVersionRequest,
} from '../src/ios/observabilityCredentialSync.ts';

const input = {
  project: 'example-app',
  secret: 'OBSERVABILITY_GITHUB_TOKEN',
  payload: 'ghp_example',
  accessToken: 'ya29.example',
};

describe('secretVersionRequest', () => {
  it('addresses the named secret and carries the credential in the body', () => {
    const request = secretVersionRequest(input);
    assert.equal(
      request.url,
      'https://secretmanager.googleapis.com/v1/projects/example-app/secrets/OBSERVABILITY_GITHUB_TOKEN:addVersion',
    );
    assert.equal(request.method, 'POST');
    assert.equal(request.headers['Authorization'], 'Bearer ya29.example');
    assert.equal(request.headers['Content-Type'], 'application/json');
    assert.deepEqual(JSON.parse(request.body), {
      payload: { data: encodeSecretPayload('ghp_example') },
    });
  });

  it('encodes a credential that JSON would otherwise have to escape', () => {
    const awkward = 'a"b\\c\ndé';
    const request = secretVersionRequest({ ...input, payload: awkward });
    const decoded = Buffer.from(
      (JSON.parse(request.body) as { payload: { data: string } }).payload.data,
      'base64',
    ).toString('utf8');
    assert.equal(decoded, awkward);
  });

  it('produces single-line standard base64', () => {
    const encoded = encodeSecretPayload('x'.repeat(200));
    assert.doesNotMatch(encoded, /\n/);
    assert.match(encoded, /^[A-Za-z0-9+/]+=*$/);
  });

  it('refuses a project or secret name that is not a bare resource name', () => {
    for (const project of ['example-app/../other', 'example site', '', 'example:site']) {
      assert.throws(() => secretVersionRequest({ ...input, project }), /project name/, project);
    }
    for (const secret of ['A/B', '..', 'A B', '']) {
      assert.throws(() => secretVersionRequest({ ...input, secret }), /secret name/, secret);
    }
  });

  it('refuses to publish an empty credential or to send an empty token', () => {
    assert.throws(() => secretVersionRequest({ ...input, payload: '' }), /credential to publish is empty/);
    assert.throws(() => secretVersionRequest({ ...input, accessToken: '' }), /access token is empty/);
  });
});

describe('secretVersionFailure', () => {
  it('accepts every 2xx, as curl --fail did', () => {
    assert.equal(secretVersionFailure(200, '{}'), null);
    assert.equal(secretVersionFailure(204, ''), null);
  });

  it('reports the status and what the service said', () => {
    assert.equal(
      secretVersionFailure(403, '  {"error":"denied"}  '),
      'Secret Manager refused the new credential version: HTTP 403 — {"error":"denied"}',
    );
  });

  it('reports a status even when the body is empty', () => {
    assert.equal(
      secretVersionFailure(500, '   '),
      'Secret Manager refused the new credential version: HTTP 500.',
    );
  });

  it('treats a redirect as a failure rather than following it', () => {
    assert.match(secretVersionFailure(302, '') ?? '', /HTTP 302/);
  });
});

interface WorkflowStep {
  readonly name: string;
  readonly run?: string;
  readonly with?: Record<string, string>;
  readonly env?: Record<string, string>;
}

interface ObservabilityWorkflow {
  readonly on: { readonly workflow_dispatch: { readonly inputs: {
    readonly test_scope: { readonly options: readonly string[] };
  } } };
  readonly jobs: Record<string, { readonly if?: string; readonly steps: readonly WorkflowStep[] }>;
}

it('routes the credential through the reviewed workflow and scoped Secret Manager grant', () => {
  const workflow = load(readFileSync('.github/workflows/ios-tests.yml', 'utf8')) as ObservabilityWorkflow;
  const scope = 'observability-credential-sync';
  assert.ok(workflow.on.workflow_dispatch.inputs.test_scope.options.includes(scope));

  const job = workflow.jobs['sync-observability-github-token'];
  assert.ok(job);
  assert.ok(job.if?.includes(`inputs.test_scope == '${scope}'`));
  const auth = job.steps.find((step) => step.name === 'Authenticate to GCP');
  assert.equal(auth?.with?.token_format, 'access_token');
  const sync = job.steps.find((step) => step.name === 'Add the current credential version');
  assert.ok(sync);
  assert.equal(sync.run, 'node .ci/observability-credential-sync/ci/src/actions/ios/syncObservabilityCredential.ts');
  assert.equal(sync.env?.GCP_PROJECT, 'example-app');
  assert.equal(sync.env?.SECRET_NAME, 'OBSERVABILITY_GITHUB_TOKEN');
  assert.equal(sync.env?.OBSERVABILITY_GITHUB_TOKEN, '${{ secrets.OBSERVABILITY_GITHUB_TOKEN }}');
  assert.equal(sync.env?.GCP_ACCESS_TOKEN, '${{ steps.gcp-auth.outputs.access_token }}');

  const terraform = readFileSync('terraform/platform/main.tf', 'utf8');
  assert.ok(terraform.includes('github_actions_ci_observability_token_writer'));
  assert.ok(terraform.includes('roles/secretmanager.secretVersionAdder'));
});
