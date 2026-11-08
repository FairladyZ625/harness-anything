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

// Positive-control fixture: a second aggregate authored-document readiness judgment must fail.
export function assessAuthoredDocumentReadiness(): { readonly state: string } {
  return { state: "ready" };
}

// Positive-control fixture: a second section-level authored-document readiness judgment must fail.
export function assessTransitionDocument(): { readonly ready: boolean } {
  return { ready: true };
}
