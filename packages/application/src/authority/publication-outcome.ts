import type { FlushReport, WriteError } from "@harness-anything/kernel";

export type AuthorityPublicationOutcome =
  | { readonly kind: "committed" }
  | { readonly kind: "rejected"; readonly reason: string }
  | { readonly kind: "retryable"; readonly reason: string }
  | { readonly kind: "indeterminate"; readonly reason: string };

const deterministicPrePublicationRejections = new Set([
  "authority_exact_batch_duplicate_operation",
  "authority_exact_batch_empty",
  "authority_exact_batch_entry_invalid",
  "authority_exact_batch_invalid",
  "authority_exact_batch_owner_mismatch",
  "authority_exact_scope_invalid",
  "code_doc_reconcile_noop"
]);

export function classifyAuthorityPublicationOutcome(input:
  | {
    readonly kind: "report";
    readonly report: FlushReport;
    readonly expectedOpCount: number;
  }
  | {
    readonly kind: "error";
    readonly error: unknown;
  }
): AuthorityPublicationOutcome {
  if (input.kind === "report") {
    if (!input.report.committed) {
      return {
        kind: "retryable",
        reason: "PUBLICATION_DID_NOT_COMMIT_EXACTLY_ONE_OPERATION"
      };
    }
    if (input.report.opCount !== input.expectedOpCount) {
      return {
        kind: "indeterminate",
        reason: `PUBLICATION_PARTIAL_COMMIT_OUTCOME_UNKNOWN:expected=${input.expectedOpCount};actual=${input.report.opCount}`
      };
    }
    return { kind: "committed" };
  }

  if (isWriteError(input.error)) {
    if (input.error._tag === "WriteRejected") {
      if (input.error.retryable) {
        return { kind: "retryable", reason: input.error.reason };
      }
      if (input.error.code && deterministicPrePublicationRejections.has(input.error.code)) {
        return { kind: "rejected", reason: input.error.reason };
      }
      return {
        kind: "indeterminate",
        reason: `PUBLICATION_OUTCOME_UNKNOWN:${input.error.reason}`
      };
    }
    if (input.error._tag === "WriteConflict" || input.error._tag === "GlobalWriteConflict") {
      return {
        kind: "retryable",
        reason: `PUBLICATION_NOT_COMMITTED:${writeErrorDescription(input.error)}`
      };
    }
  }
  return {
    kind: "indeterminate",
    reason: `PUBLICATION_OUTCOME_UNKNOWN:${errorDescription(input.error)}`
  };
}

function isWriteError(error: unknown): error is WriteError {
  if (typeof error !== "object" || error === null || !("_tag" in error)) return false;
  return error._tag === "WriteRejected"
    || error._tag === "WriteConflict"
    || error._tag === "GlobalWriteConflict"
    || error._tag === "JournalUnavailable";
}

function writeErrorDescription(error: Exclude<WriteError, { readonly _tag: "JournalUnavailable" }>): string {
  if (error._tag === "WriteRejected") return error.reason;
  return error.owner ?? error._tag;
}

function errorDescription(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (isWriteError(error)) {
    if (error._tag === "JournalUnavailable") return errorDescription(error.cause);
    return writeErrorDescription(error);
  }
  return String(error);
}
