import type { ArtifactStoreError, EngineError, WriteError } from "../../../kernel/src/domain/index.ts";
import { cliError, CliErrorCode } from "./error-codes.ts";
import type { CliResult } from "./types.ts";

export function toCliError(error: ArtifactStoreError | EngineError | WriteError): CliResult["error"] {
  switch (error._tag) {
    case "EngineOwnsStatus":
      return cliError(CliErrorCode.EngineOwnsStatus, `Status is owned by ${error.engine}; change it in that engine context.`);
    case "EngineNotEnabled":
      return cliError(CliErrorCode.EngineNotEnabled, "Command failed.");
    case "AdapterUnavailable":
      return cliError(CliErrorCode.AdapterUnavailable, "Command failed.");
    case "AuthMissing":
      return cliError(CliErrorCode.AuthMissing, "Command failed.");
    case "RefNotFound":
      return cliError(CliErrorCode.RefNotFound, "Command failed.");
    case "TaskAlreadyExists":
      return cliError(CliErrorCode.TaskAlreadyExists, `task already exists: ${error.taskId}`);
    case "TaskNotFound":
      return cliError(CliErrorCode.TaskNotFound, `task not found: ${error.taskId}`);
    case "InvalidTransition":
      return cliError(CliErrorCode.InvalidTransition, `invalid transition: ${error.from} -> ${error.to}`);
    case "DuplicateExternalBinding":
      return cliError(CliErrorCode.DuplicateExternalBinding, `external ref already bound: ${error.engine} ${error.ref}`);
    case "DuplicateAdoptClaim":
      return cliError(CliErrorCode.DuplicateAdoptClaim, `adopt claim already held: ${error.engine} ${error.ref}`);
    case "StaleSnapshotRefused":
      return cliError(CliErrorCode.StaleSnapshotRefused, `cannot adopt stale ${error.engine} snapshot: ${error.ref}`);
    case "GeneratedTaskIdRequired":
      return cliError(CliErrorCode.GeneratedTaskIdRequired, `task id must be generated: ${error.taskId}`);
    case "MalformedSnapshot":
      return cliError(CliErrorCode.MalformedSnapshot, String(error.raw));
    case "StatusUnmapped":
      return cliError(CliErrorCode.StatusUnmapped, "Command failed.");
    case "TerminalReopenRequiresSupersede":
      return cliError(CliErrorCode.TerminalReopenRequiresSupersede, `Task ${error.taskId} is ${error.status}; create follow-up work with harness-anything task supersede.`);
    case "ArchivedHardDeleteForbidden":
      return cliError(CliErrorCode.ArchivedHardDeleteForbidden, `Task ${error.taskId} is archived; keep audit history or use soft delete.`);
    case "TerminalHardDeleteForbidden":
      return cliError(CliErrorCode.TerminalHardDeleteForbidden, `Task ${error.taskId} is ${error.status}; terminal work cannot be hard deleted.`);
    case "RelatedTaskHardDeleteForbidden":
      return cliError(CliErrorCode.RelatedTaskHardDeleteForbidden, `Task ${error.taskId} has task relations; remove or supersede relations before hard delete.`);
    case "RateLimited":
      return cliError(CliErrorCode.RateLimited, "Command failed.");
    case "EngineUnreachable":
      return cliError(CliErrorCode.EngineUnreachable, "Command failed.");
    case "Timeout":
      return cliError(CliErrorCode.Timeout, "Command failed.");
    case "WriteConflict":
      return cliError(CliErrorCode.WriteConflict, error.owner ?? "Write lock is held.");
    case "WriteRejected":
      return cliError(CliErrorCode.WriteRejected, error.reason);
    case "ArtifactReadFailed":
      return cliError(CliErrorCode.ArtifactReadFailed, "Artifact read failed.");
    case "ArtifactWriteRejected":
      return cliError(CliErrorCode.ArtifactWriteRejected, error.reason);
    case "TaskPackageNotFound":
      return cliError(CliErrorCode.TaskNotFound, `task not found: ${error.taskId}`);
    case "JournalUnavailable": {
      const cause = journalUnavailableCause(error.cause);
      return cliError(CliErrorCode.JournalUnavailable, cause ? `Journal is unavailable: ${cause}` : "Journal is unavailable.");
    }
  }
  return assertNever(error);
}

function assertNever(value: never): never {
  throw new Error(`Unhandled CLI error tag: ${JSON.stringify(value)}`);
}

function journalUnavailableCause(cause: unknown): string {
  if (cause instanceof Error) return firstLine(cause.message);
  if (typeof cause === "string") return firstLine(cause);
  return "";
}

function firstLine(value: string): string {
  return value.trim().split(/\r?\n/u).find((line) => line.trim().length > 0)?.trim() ?? "";
}
