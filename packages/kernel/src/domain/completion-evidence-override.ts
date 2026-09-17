/**
 * A break-glass waiver: a human pass that assumes responsibility for this cut. `waivedReceiptId`
 * names the recorded automated `fail` it covers; `null` records that the cut has no automated
 * receipt at all (the environment never produced one). The waived fail witness stays recorded —
 * the override only names it — and a null waiver is voided by any automated receipt that lands.
 */
export interface CompletionEvidenceOverride {
  readonly rationale: string;
  readonly waivedReceiptId: string | null;
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
    (record.waivedReceiptId === null ||
      (typeof record.waivedReceiptId === "string" && record.waivedReceiptId.length > 0))
  );
}
