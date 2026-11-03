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

export function executionCredentialRejected(
  reason:
    | "scope"
    | "write-other-task"
    | "self-approval"
    | "read-only-allowlist"
    | "expired"
    | "revoked"
    | "authentication" = "scope",
): Error {
  const message = {
    scope:
      "Execution request is outside its dispatch scope. Read requests are available; writes are limited to this task. Use `ha task show` or `ha task read-set` to inspect task data.",
    "write-other-task":
      "Execution write was rejected because it targets another task or repository. Writes are limited to this task; use `ha task show` to inspect other tasks.",
    "self-approval":
      "Execution write was rejected because it requires human approval or access administration. Use the corresponding human review or access command.",
    "read-only-allowlist":
      "This read-only dispatch may only run the allowlisted ledger queries " +
      "(ha work list/show, ha task list/show, ha agenda, ha runtime status, ha schedule list/runs); " +
      "the daemon rejected this command outside that allowlist.",
    expired: "Execution credential is expired.",
    revoked: "Execution credential is revoked.",
    authentication: "Execution credential authentication was rejected.",
  }[reason];
  return Object.assign(new Error(message), {
    code: "execution_credential_rejected",
  });
}
