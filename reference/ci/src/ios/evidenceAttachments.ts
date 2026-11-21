export interface EvidenceAttachment {
  readonly suggestedHumanReadableName: string;
  readonly isAssociatedWithFailure: boolean;
  readonly exportedFileName: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export function isEvidenceAttachment(value: unknown): value is EvidenceAttachment {
  return isRecord(value)
    && typeof value.suggestedHumanReadableName === 'string'
    && typeof value.isAssociatedWithFailure === 'boolean'
    && typeof value.exportedFileName === 'string';
}

export function namedEvidenceAttachments(
  attachments: readonly unknown[],
  matchesName: (name: string) => boolean,
): unknown[] {
  return attachments.filter(attachment => (
    isRecord(attachment)
    && typeof attachment.suggestedHumanReadableName === 'string'
    && matchesName(attachment.suggestedHumanReadableName)
  ));
}
