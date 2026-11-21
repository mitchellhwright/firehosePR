import { z } from 'zod';

/** Only the trusted checkpoint App may attest the version it selected. */
export const promotionCheckpointUser = {
  login: 'example-promotion-checkpoint[bot]',
  id: 324658254,
  type: 'Bot',
} as const;

const commentSchema = z.object({
  body: z.string(),
  user: z.object({ login: z.string(), id: z.number(), type: z.string() }),
});
const attestationSchema = z.object({
  sourceSha: z.string().regex(/^[0-9a-f]{40}$/u),
  commitSha: z.string().regex(/^[0-9a-f]{40}$/u),
  version: z.string().regex(/^\d+\.\d+\.\d+$/u),
});
const marker = '<!-- example-promotion-version-attestation-v1 -->\n';

export interface VersionAttestation {
  readonly sourceSha: string;
  readonly commitSha: string;
  readonly version: string;
}

export function versionAttestationBody(attestation: VersionAttestation): string {
  if (!/^[0-9a-f]{40}$/u.test(attestation.sourceSha)
    || !/^[0-9a-f]{40}$/u.test(attestation.commitSha)
    || !/^\d+\.\d+\.\d+$/u.test(attestation.version)) {
    throw new Error('Promotion version attestation requires exact source, commit and version values.');
  }
  return marker + JSON.stringify(attestation);
}

export function allTrustedVersionAttestations(comments: readonly unknown[]): VersionAttestation[] {
  const result: VersionAttestation[] = [];
  for (const comment of comments) {
    const parsed = commentSchema.safeParse(comment);
    if (!parsed.success) continue;
    const { user, body } = parsed.data;
    if (user.login !== promotionCheckpointUser.login || user.id !== promotionCheckpointUser.id
      || user.type !== promotionCheckpointUser.type || !body.startsWith(marker)) continue;
    let payload: unknown;
    try { payload = JSON.parse(body.slice(marker.length)) as unknown; }
    catch { continue; }
    const attestation = attestationSchema.safeParse(payload);
    if (!attestation.success || body !== versionAttestationBody(attestation.data)) continue;
    result.push(attestation.data);
  }
  return result;
}

export function trustedVersionAttestations(comments: readonly unknown[], sourceSha: string): VersionAttestation[] {
  return allTrustedVersionAttestations(comments).filter((attestation) => attestation.sourceSha === sourceSha);
}

/** The body is matched exactly; a writer cannot impersonate the App user ID. */
export function hasTrustedVersionAttestation(
  comments: readonly unknown[],
  attestation: VersionAttestation,
): boolean {
  return trustedVersionAttestations(comments, attestation.sourceSha).some((candidate) =>
    candidate.commitSha === attestation.commitSha && candidate.version === attestation.version);
}
