import type { HarnessLayoutInput } from "@harness-anything/kernel";
import { profileIssue, type ProfileValidationIssue } from "./check-profile-types.ts";
import { verifyDecisionContentPins } from "./core/decision-content-pin-verifier.ts";

export function attachDecisionContentPinWarnings(
  rootInput: HarnessLayoutInput,
  report: Record<string, unknown>,
  issues: ProfileValidationIssue[]
): Record<string, unknown> {
  const verification = verifyDecisionContentPins(rootInput);
  for (const warning of verification.warnings) {
    issues.push(profileIssue(
      "vertical-check:decision-content-pin",
      warning.code,
      "warning",
      warning.message,
      "Review the Git trace; sanctioned load-bearing amendments must append a new content pin."
    ));
  }
  const summary = asRecordValue(report.summary) ?? {};
  return {
    ...report,
    summary: { ...summary, contentPinWarningCount: verification.warnings.length },
    contentPinWarnings: verification.warnings
  };
}

function asRecordValue(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  return value as Record<string, unknown>;
}
