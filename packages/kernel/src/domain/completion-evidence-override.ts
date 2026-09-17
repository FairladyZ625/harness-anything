/**
 * A break-glass waiver: a human pass over one recorded automated `fail` on the same cut. The
 * waived fail witness stays recorded; the override only names it.
 */
export interface CompletionEvidenceOverride {
  readonly rationale: string;
  readonly waivedReceiptId: string;
}

export const OVERRIDE_RATIONALE_MIN_LENGTH = 10;

export function validOverrideRationale(value: unknown): value is string {
  return typeof value === "string" && [...value.trim()].length >= OVERRIDE_RATIONALE_MIN_LENGTH;
}

export function validCompletionEvidenceOverride(value: unknown): value is CompletionEvidenceOverride {
  const record = value as Partial<CompletionEvidenceOverride> | null;
  return (
    typeof record === "object" &&
    record !== null &&
    Object.keys(record).every((field) => field === "rationale" || field === "waivedReceiptId") &&
    validOverrideRationale(record.rationale) &&
    typeof record.waivedReceiptId === "string" &&
    record.waivedReceiptId.length > 0
  );
}
