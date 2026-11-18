import { reviewDispatchFailureWarning, type TaskReviewDispatchFailureV1 } from "@harness-anything/kernel";
export { reviewDispatchFailureWarning };

/** Preserve the boundary's code and explanation; recovery advice supplements the actual failure. */
export function reviewDispatchDiagnostic(input: { readonly code: string | null; readonly message: string }) {
  const code = input.code ?? "node_auto_dispatch_failed",
    authentication = ["human_confirmation_required", "authentication_required", "oidc_device_expired"].includes(code),
    recovery = authentication
      ? " The personal access token or session is missing, expired or revoked. Sign in to the center again with ha bootstrap --operation login and sync this node before retrying."
      : code === "execution_credential_rejected"
        ? " The execution credential is expired or revoked. Sign in again with ha bootstrap --operation login and ask the owner to sync the node or renew the execution before retrying."
        : "";
  return { code, message: `${input.message}${recovery}` };
}

export function withReviewDispatchFailures<T extends Record<string, unknown>>(
  receipt: T,
  failures: readonly TaskReviewDispatchFailureV1[],
):
  | T
  | (T & {
      readonly reviewDispatchFailures: readonly TaskReviewDispatchFailureV1[];
      readonly warnings: readonly unknown[];
    }) {
  if (failures.length === 0) return receipt;
  const warnings = failures.map(reviewDispatchFailureWarning);
  return {
    ...receipt,
    reviewDispatchFailures: failures,
    warnings: [...(Array.isArray(receipt.warnings) ? receipt.warnings : []), ...warnings],
    summary: [receipt.summary, ...warnings].filter(Boolean).join("\n"),
  };
}
