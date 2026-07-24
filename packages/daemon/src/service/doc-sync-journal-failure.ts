import type {
  DocSyncSubmitRequestV1,
  DocSyncSubmitResultV1
} from "@harness-anything/application";
import type { WriteError } from "@harness-anything/kernel";

export class DocSyncJournalFailure extends Error {
  readonly writeError: WriteError;

  constructor(writeError: WriteError) {
    super(writeErrorReason(writeError));
    this.name = "DocSyncJournalFailure";
    this.writeError = writeError;
  }
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
  code: Extract<DocSyncSubmitResultV1, { readonly ok: false }>["code"],
  reason: string,
  retryable: boolean,
  tag?: "JournalUnavailable" | "WriteRejected"
): DocSyncSubmitResultV1 {
  return {
    ok: false,
    ...(tag ? { _tag: tag } : {}),
    schema: "daemon.doc-sync-submit-result/v1",
    status: "rejected",
    intentId: request.payload.intentId,
    code,
    reason,
    retryable
  };
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
