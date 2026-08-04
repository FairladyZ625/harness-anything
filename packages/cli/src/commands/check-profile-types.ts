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

export function strictSeverity(strict: boolean): "warning" | "hard-fail" {
  return strict ? "hard-fail" : "warning";
}

export function isCheckProfile(value: string): value is CheckProfile {
  return value === "source-package" || value === "private-harness" || value === "target-project";
}
import type { CheckProfile } from "../cli/types.ts";
