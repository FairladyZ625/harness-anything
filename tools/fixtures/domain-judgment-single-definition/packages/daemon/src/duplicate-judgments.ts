// Positive-control fixture: daemon-owned definitions must fail the single-definition gate.
export function canStartExecution(): boolean {
  return true;
}

export function queryPayloadValidation(): readonly string[] {
  return [];
}

export const statusVocabularies = ["copied"] as const;
