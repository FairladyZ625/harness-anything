export const ownerValidationRevivalCondition =
  "Reinstate a hard rejection only after a third independent user, external auditor, or writer outside direct owner review exists and a real incident is documented.";

export function demotedGateWarning(
  code: string,
  message: string,
  revivalCondition = ownerValidationRevivalCondition
): {
  readonly severity: "warning";
  readonly code: string;
  readonly message: string;
  readonly revivalCondition: string;
} {
  return {
    severity: "warning",
    code,
    message,
    revivalCondition
  };
}
