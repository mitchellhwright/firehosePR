/**
 * The Secret Manager `addVersion` request that publishes the observability
 * dashboard's GitHub credential.
 *
 * The replaced shell built this request by substituting the base64 credential
 * into a JSON string and handing the result to `curl --data`, which put the
 * encoded secret in the process arguments where any other process on the
 * runner could read it. Here the payload is a value: it is encoded, placed in
 * an object, and serialised by `JSON.stringify`, so neither the credential nor
 * the access token ever appears in an argument list, and a byte that would
 * have to be escaped in JSON is escaped by the serialiser rather than by hand.
 *
 * Nothing in this module performs the request; it only describes it.
 */

export interface SecretVersionRequest {
  readonly url: string;
  readonly method: 'POST';
  readonly headers: Readonly<Record<string, string>>;
  readonly body: string;
}

export interface SecretVersionInput {
  readonly project: string;
  readonly secret: string;
  /** The credential to publish, in its raw form. */
  readonly payload: string;
  readonly accessToken: string;
}

/** Secret Manager takes the payload as standard base64 on a single line. */
export function encodeSecretPayload(payload: string): string {
  return Buffer.from(payload, 'utf8').toString('base64');
}

/**
 * A project or secret name is part of the URL path, so anything outside the
 * names Google itself allows is refused rather than escaped: a `/` or a `..`
 * would silently address a different secret.
 */
const resourceNamePattern = /^[A-Za-z0-9_-]+$/;

export function secretVersionRequest(input: SecretVersionInput): SecretVersionRequest {
  for (const [label, value] of [['project', input.project], ['secret', input.secret]] as const) {
    if (!resourceNamePattern.test(value)) {
      throw new Error(`Secret Manager ${label} name is not a bare resource name: ${value}`);
    }
  }
  if (input.payload.length === 0) throw new Error('The credential to publish is empty');
  if (input.accessToken.length === 0) throw new Error('The GCP access token is empty');
  return {
    url:
      'https://secretmanager.googleapis.com/v1/projects/' +
      `${input.project}/secrets/${input.secret}:addVersion`,
    method: 'POST',
    headers: {
      Authorization: `Bearer ${input.accessToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ payload: { data: encodeSecretPayload(input.payload) } }),
  };
}

/** What the step reports for a response, keeping `--fail`'s status-only rule. */
export function secretVersionFailure(status: number, detail: string): string | null {
  if (status >= 200 && status < 300) return null;
  const trimmed = detail.trim();
  return (
    `Secret Manager refused the new credential version: HTTP ${status}` +
    (trimmed.length > 0 ? ` — ${trimmed}` : '.')
  );
}
