import { isIndeterminateFlushReport, type FlushReport, type WriteError } from "@harness-anything/kernel";

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
    if (isIndeterminateFlushReport(input.report)) {
      return {
        kind: "indeterminate",
        reason: input.report.cause.kind === "authority"
          ? input.report.cause.evidence
          : input.report.cause.detail
      };
    }
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
  if (error._tag === "WriteRejected") {
    return "reason" in error && typeof error.reason === "string";
  }
  if (error._tag === "WriteConflict" || error._tag === "GlobalWriteConflict") {
    return !("owner" in error) || error.owner === undefined || typeof error.owner === "string";
  }
  return error._tag === "JournalUnavailable";
}

function writeErrorDescription(error: Exclude<WriteError, { readonly _tag: "JournalUnavailable" }>): string {
  if (error._tag === "WriteRejected") return error.reason;
  return error.owner ?? error._tag;
}

function errorDescription(error: unknown): string {
  return describeUnknownFailure(error, new Set<object>());
}

function describeUnknownFailure(error: unknown, ancestors: Set<object>): string {
  if (error instanceof Error) return error.message || error.name;
  if (typeof error === "string") return error;
  if (typeof error === "number" || typeof error === "bigint" || typeof error === "boolean") return String(error);
  if (error === null) return "null";
  if (error === undefined) return "undefined";
  if (typeof error !== "object") return typeof error;
  if (ancestors.has(error)) return "[Circular]";
  ancestors.add(error);
  if (isWriteError(error)) {
    if (error._tag === "JournalUnavailable") return describeUnknownFailure(error.cause, ancestors);
    return writeErrorDescription(error);
  }
  for (const field of ["reason", "message", "cause", "error"] as const) {
    const value = readObjectField(error, field);
    if (value !== undefined && value !== error) return describeUnknownFailure(value, ancestors);
  }
  return safeJsonDescription(error);
}

function readObjectField(value: object, field: string): unknown {
  try {
    return field in value ? (value as Record<string, unknown>)[field] : undefined;
  } catch {
    return undefined;
  }
}

function safeJsonDescription(value: object): string {
  const visited = new WeakSet<object>();
  try {
    return JSON.stringify(value, (_key, member: unknown) => {
      if (typeof member !== "object" || member === null) return member;
      if (visited.has(member)) return "[Circular]";
      visited.add(member);
      return member;
    }) || "unrenderable object";
  } catch {
    return "unrenderable object";
  }
}
