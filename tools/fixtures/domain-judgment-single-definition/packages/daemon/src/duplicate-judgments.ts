// Positive-control fixture: daemon-owned definitions must fail the single-definition gate.
export function canStartExecution(): boolean {
  return true;
}

export function queryPayloadValidation(): readonly string[] {
  return [];
}

export const statusVocabularies = ["copied"] as const;

// Positive-control fixture: a second bilingual closeout judgment in the daemon must fail the gate.
export function missingChineseCloseoutSections(): readonly string[] {
  return ["摘要", "验证"];
}
