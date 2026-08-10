import type {
  DocSyncSubmitRequestV1,
  DocSyncSubmitResultV1
} from "@harness-anything/application";
import {
  isIndeterminateFlushControlOutcome,
  type WriteError
} from "@harness-anything/kernel";

type RejectedDocSyncSubmitResult = Extract<DocSyncSubmitResultV1, { readonly status: "rejected" }>;

export function rejectDocSyncRequest(
  request: DocSyncSubmitRequestV1,
  code: RejectedDocSyncSubmitResult["code"],
  reason: string,
  retryable: boolean,
  extra: Partial<RejectedDocSyncSubmitResult> = {}
): RejectedDocSyncSubmitResult {
  return {
    ok: false,
    schema: "daemon.doc-sync-submit-result/v1",
    status: "rejected",
    intentId: request.payload.intentId,
    code,
    reason,
    retryable,
    ...extra
  };
}

export class DocSyncJournalFailure extends Error {
  readonly writeError: WriteError;

  constructor(writeError: WriteError) {
    super(writeErrorReason(writeError));
    this.name = "DocSyncJournalFailure";
    this.writeError = writeError;
  }
}

export function docSyncIndeterminate(
  request: DocSyncSubmitRequestV1,
  error: unknown
): DocSyncSubmitResultV1 | undefined {
  if (!isIndeterminateFlushControlOutcome(error)) return undefined;
  return {
    ok: false,
    _tag: "IndeterminateFlushControlOutcome",
    schema: "daemon.doc-sync-submit-result/v1",
    status: "indeterminate",
    intentId: request.payload.intentId,
    code: "write_outcome_indeterminate",
    reason: `Canonical commitment proof is unavailable for doc sync operation ${error.report.operationIds.join(",")}. Run 'ha daemon logs --error-only --json', compare that ID with canonical Git state, and do not retry the original write blindly.`,
    hint: "Canonical commitment proof is unavailable. Run 'ha daemon logs --error-only --json', inspect the attached flush operation IDs in canonical Git state, and do not retry the original write blindly.",
    retryable: false,
    flush: error.report
  };
}

export function docSyncWriteFailure(
  request: DocSyncSubmitRequestV1,
  error: unknown
): DocSyncSubmitResultV1 | undefined {
  if (!(error instanceof DocSyncJournalFailure)) return undefined;
  if (error.writeError._tag === "JournalUnavailable") {
    return docSyncJournalUnavailable(request, error.message);
  }
  return rejection(
    request,
    "doc_sync_invalid_payload",
    error.message,
    error.writeError._tag === "WriteRejected"
      ? error.writeError.retryable ?? false
      : false,
    error.writeError._tag === "WriteRejected" ? "WriteRejected" : undefined
  );
}

export function docSyncJournalUnavailable(
  request: DocSyncSubmitRequestV1,
  reason: string
): DocSyncSubmitResultV1 {
  return rejection(
    request,
    "journal_unavailable",
    `${reason} Run 'ha daemon status --json', then retry 'ha doc sync --submit'.`,
    true,
    "JournalUnavailable"
  );
}

function rejection(
  request: DocSyncSubmitRequestV1,
  code: RejectedDocSyncSubmitResult["code"],
  reason: string,
  retryable: boolean,
  tag?: "JournalUnavailable" | "WriteRejected"
): RejectedDocSyncSubmitResult {
  return rejectDocSyncRequest(request, code, reason, retryable, tag ? { _tag: tag } : {});
}

function writeErrorReason(error: WriteError): string {
  if (error._tag === "WriteRejected") return error.reason;
  if (error._tag === "WriteConflict") {
    return `write conflict${error.owner ? ` owned by ${error.owner}` : ""}`;
  }
  if (error._tag === "GlobalWriteConflict") {
    return `global write conflict${error.owner ? ` owned by ${error.owner}` : ""}`;
  }
  return `journal unavailable: ${causeReason(error.cause)}`;
}

function causeReason(cause: unknown): string {
  if (cause instanceof Error) return cause.stack ?? cause.message;
  if (typeof cause === "string") return cause;
  if (cause === undefined) return "no cause was provided";
  try {
    return JSON.stringify(cause);
  } catch {
    return String(cause);
  }
}
