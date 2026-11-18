import type { WriteSource } from "../domain/write-source.ts";

/** One runtime dispatch, twelve hours, no renewal. The selected identity provider owns the secret and its revocation. */
export const runtimeExecutionLifetimeMs = 12 * 60 * 60 * 1000;

export interface RuntimeExecutionPrincipal {
  readonly personId: string;
  readonly repoId: string;
  readonly runtimeSessionId: string;
  readonly dispatchId: string;
  /**
   * Unbound sessions hold no task lease. A session retains the spawning person's repository
   * permissions; a read-only dispatch is limited to allowlisted reads.
   */
  readonly taskId: string | null;
  readonly executionId: string | null;
  readonly role: "implementation" | "reviewer" | "read-only" | "session";
  /** Task surfaces frozen into implementation credentials at dispatch; absent legacy grants mean none. */
  readonly surfaces?: readonly string[];
  /** Decision review dispatches bind reads to this canonical decision id. */
  readonly reviewDecisionId?: string;
  /** Task review dispatches bind reads to this canonical task id. */
  readonly reviewTaskId?: string;
  readonly source: WriteSource;
  readonly expiresAt: string;
}

export interface ExecutionCredentialRejectionContext {
  readonly expiresAt?: string;
  readonly dispatchId?: string;
  readonly role?: RuntimeExecutionPrincipal["role"];
  readonly detail?: string;
  readonly overrideMessage?: string;
}

function attachExecutionRejectionMetadata(
  error: Error,
  reason: string,
  context?: ExecutionCredentialRejectionContext,
): Error {
  Object.defineProperty(error, "executionRejectionReason", { value: reason, enumerable: false });
  if (context?.role) Object.defineProperty(error, "executionRejectionRole", { value: context.role, enumerable: false });
  if (context?.dispatchId)
    Object.defineProperty(error, "executionRejectionDispatchId", { value: context.dispatchId, enumerable: false });
  return error;
}

export function executionCredentialRejected(
  reason:
    | "scope"
    | "write-other-task"
    | "self-approval"
    | "read-only-allowlist"
    | "expired"
    | "revoked"
    | "authentication" = "scope",
  context?: ExecutionCredentialRejectionContext,
): Error {
  const scopeLead = "Execution request is outside its dispatch scope.",
    dispatchPrefix = context?.dispatchId ? ` for ${context.role ?? "runtime"} dispatch ${context.dispatchId}` : "";
  let message: string;
  if (context?.overrideMessage !== undefined) {
    message = context.overrideMessage;
  } else if (reason === "expired") {
    const expiredLead = context?.expiresAt
      ? `Execution credential${dispatchPrefix} expired at ${context.expiresAt}.`
      : `Execution credential${dispatchPrefix} is expired.`;
    const recovery =
      context?.role === "reviewer"
        ? " Ask the task owner or operator to settle or cancel the stale dispatch and issue a fresh review dispatch; do not retry review-execution with this credential."
        : " Ask the task owner or operator to settle or re-dispatch the runtime if work remains; do not retry writes with this credential.";
    message = `${expiredLead}${recovery}${context?.detail ? ` ${context.detail}` : ""}`;
  } else if (reason === "revoked") {
    message = context?.dispatchId
      ? `Execution credential is revoked. (${context.role ?? "runtime"} dispatch ${context.dispatchId})${context?.detail ? ` ${context.detail}` : ""}`
      : `Execution credential is revoked.${context?.detail ? ` ${context.detail}` : ""}`;
  } else if (reason === "authentication") {
    message = context?.detail
      ? `Execution credential authentication was rejected${dispatchPrefix}. ${context.detail}`
      : "Execution credential authentication was rejected.";
  } else if (reason === "scope") {
    message = context?.detail
      ? `${scopeLead} ${context.detail}`
      : `${scopeLead} Read requests are available; writes are limited to this task. Use \`ha task show\` or \`ha task read-set\` to inspect task data.`;
  } else {
    message = {
      "write-other-task":
        "Execution write was rejected because it targets another task or repository. Writes are limited to this task; use `ha task show` to inspect other tasks.",
      "self-approval":
        "Execution write was rejected because it requires human approval or access administration. Use the corresponding human review or access command.",
      "read-only-allowlist":
        "This read-only dispatch may only run the allowlisted ledger queries " +
        "(ha work list/show, ha task list/show, ha agenda, ha runtime status, ha schedule list/runs); " +
        "the daemon rejected this command outside that allowlist.",
    }[reason];
    if (context?.detail) message = `${message} ${context.detail}`;
  }
  return attachExecutionRejectionMetadata(
    Object.assign(new Error(message), {
      code: "execution_credential_rejected",
    }),
    reason,
    context,
  );
}
