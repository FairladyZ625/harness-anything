export interface ProfileValidationIssue {
  readonly code: string;
  readonly source: string;
  readonly severity: "warning" | "hard-fail";
  readonly message: string;
  readonly repairHint: string;
}

export function profileIssue(source: string, code: string, severity: "warning" | "hard-fail", message: string, repairHint: string): ProfileValidationIssue {
  return { source, code, severity, message, repairHint };
}
