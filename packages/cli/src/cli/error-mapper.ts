import type { ArtifactStoreError, EngineError, WriteError } from "../../../kernel/src/domain/index.ts";
import type { CliResult } from "./types.ts";

export function toCliError(error: ArtifactStoreError | EngineError | WriteError): CliResult["error"] {
  switch (error._tag) {
    case "EngineOwnsStatus":
      return {
        code: "engine_owns_status",
        hint: `Status is owned by ${error.engine}; change it in that engine context.`
      };
    case "TaskAlreadyExists":
      return { code: "task_already_exists", hint: `task already exists: ${error.taskId}` };
    case "TaskNotFound":
      return { code: "task_not_found", hint: `task not found: ${error.taskId}` };
    case "InvalidTransition":
      return { code: "invalid_transition", hint: `invalid transition: ${error.from} -> ${error.to}` };
    case "DuplicateExternalBinding":
      return { code: "duplicate_external_binding", hint: `external ref already bound: ${error.engine} ${error.ref}` };
    case "DuplicateAdoptClaim":
      return { code: "duplicate_adopt_claim", hint: `adopt claim already held: ${error.engine} ${error.ref}` };
    case "StaleSnapshotRefused":
      return { code: "stale_snapshot_refused", hint: `cannot adopt stale ${error.engine} snapshot: ${error.ref}` };
    case "GeneratedTaskIdRequired":
      return { code: "generated_task_id_required", hint: `task id must be generated: ${error.taskId}` };
    case "MalformedSnapshot":
      return { code: "malformed_snapshot", hint: String(error.raw) };
    case "TerminalReopenRequiresSupersede":
      return {
        code: "terminal_reopen_requires_supersede",
        hint: `Task ${error.taskId} is ${error.status}; create follow-up work with harness-anything task supersede.`
      };
    case "ArchivedHardDeleteForbidden":
      return {
        code: "archived_hard_delete_forbidden",
        hint: `Task ${error.taskId} is archived; keep audit history or use soft delete.`
      };
    case "TerminalHardDeleteForbidden":
      return {
        code: "terminal_hard_delete_forbidden",
        hint: `Task ${error.taskId} is ${error.status}; terminal work cannot be hard deleted.`
      };
    case "RelatedTaskHardDeleteForbidden":
      return {
        code: "related_task_hard_delete_forbidden",
        hint: `Task ${error.taskId} has task relations; remove or supersede relations before hard delete.`
      };
    case "WriteConflict":
      return { code: "write_conflict", hint: error.owner ?? "Write lock is held." };
    case "WriteRejected":
      return { code: "write_rejected", hint: error.reason };
    case "ArtifactReadFailed":
      return { code: "artifact_read_failed", hint: "Artifact read failed." };
    case "ArtifactWriteRejected":
      return { code: "artifact_write_rejected", hint: error.reason };
    case "TaskPackageNotFound":
      return { code: "task_not_found", hint: `task not found: ${error.taskId}` };
    case "JournalUnavailable": {
      const cause = journalUnavailableCause(error.cause);
      return { code: "journal_unavailable", hint: cause ? `Journal is unavailable: ${cause}` : "Journal is unavailable." };
    }
    default:
      return { code: error._tag, hint: "Command failed." };
  }
}

function journalUnavailableCause(cause: unknown): string {
  if (cause instanceof Error) return firstLine(cause.message);
  if (typeof cause === "string") return firstLine(cause);
  return "";
}

function firstLine(value: string): string {
  return value.trim().split(/\r?\n/u).find((line) => line.trim().length > 0)?.trim() ?? "";
}
