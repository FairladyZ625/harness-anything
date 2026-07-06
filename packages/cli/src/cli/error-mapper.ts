import type { ArtifactStoreError, EngineError, WriteError } from "../../../kernel/src/index.ts";
import { cliError, CliErrorCode } from "./error-codes.ts";
import type { CliResult } from "./types.ts";

type CliReachableKernelError = ArtifactStoreError | EngineError | WriteError;
type KernelErrorTag = CliReachableKernelError["_tag"];
type CliErrorMapperByTag = {
  readonly [Tag in KernelErrorTag]: (error: Extract<CliReachableKernelError, { readonly _tag: Tag }>) => CliResult["error"];
};

const cliErrorMappers = {
  EngineOwnsStatus: (error) => cliError(CliErrorCode.EngineOwnsStatus, `Status is owned by ${error.engine}; change it in that engine context.`),
  EngineNotEnabled: () => cliError(CliErrorCode.EngineNotEnabled, "Command failed."),
  AdapterUnavailable: () => cliError(CliErrorCode.AdapterUnavailable, "Command failed."),
  AuthMissing: () => cliError(CliErrorCode.AuthMissing, "Command failed."),
  RefNotFound: () => cliError(CliErrorCode.RefNotFound, "Command failed."),
  TaskAlreadyExists: (error) => cliError(CliErrorCode.TaskAlreadyExists, `task already exists: ${error.taskId}`),
  TaskNotFound: (error) => cliError(CliErrorCode.TaskNotFound, `task not found: ${error.taskId}`),
  InvalidTransition: (error) => cliError(CliErrorCode.InvalidTransition, `invalid transition: ${error.from} -> ${error.to}`),
  DuplicateExternalBinding: (error) => cliError(CliErrorCode.DuplicateExternalBinding, `external ref already bound: ${error.engine} ${error.ref}`),
  DuplicateAdoptClaim: (error) => cliError(CliErrorCode.DuplicateAdoptClaim, `adopt claim already held: ${error.engine} ${error.ref}`),
  StaleSnapshotRefused: (error) => cliError(CliErrorCode.StaleSnapshotRefused, `cannot adopt stale ${error.engine} snapshot: ${error.ref}`),
  GeneratedTaskIdRequired: (error) => cliError(CliErrorCode.GeneratedTaskIdRequired, `task id must be generated: ${error.taskId}`),
  MalformedSnapshot: (error) => cliError(CliErrorCode.MalformedSnapshot, String(error.raw)),
  StatusUnmapped: () => cliError(CliErrorCode.StatusUnmapped, "Command failed."),
  TerminalReopenRequiresSupersede: (error) => cliError(CliErrorCode.TerminalReopenRequiresSupersede, `Task ${error.taskId} is ${error.status}; create follow-up work with harness-anything task supersede.`),
  ArchivedHardDeleteForbidden: (error) => cliError(CliErrorCode.ArchivedHardDeleteForbidden, `Task ${error.taskId} is archived; keep audit history or use soft delete.`),
  TerminalHardDeleteForbidden: (error) => cliError(CliErrorCode.TerminalHardDeleteForbidden, `Task ${error.taskId} is ${error.status}; terminal work cannot be hard deleted.`),
  RelatedTaskHardDeleteForbidden: (error) => cliError(CliErrorCode.RelatedTaskHardDeleteForbidden, error.reason ?? `Task ${error.taskId} has active incoming relations; use archive, supersede, or retire the related records before hard delete.`),
  RateLimited: () => cliError(CliErrorCode.RateLimited, "Command failed."),
  EngineUnreachable: () => cliError(CliErrorCode.EngineUnreachable, "Command failed."),
  Timeout: () => cliError(CliErrorCode.Timeout, "Command failed."),
  WriteConflict: (error) => cliError(CliErrorCode.WriteConflict, error.owner ?? "Write lock is held."),
  GlobalWriteConflict: (error) => cliError(CliErrorCode.WriteConflict, error.owner ? `Global write lock is held: ${error.owner}` : "Global write lock is held."),
  WriteRejected: (error) => cliError(CliErrorCode.WriteRejected, error.reason),
  ArtifactReadFailed: () => cliError(CliErrorCode.ArtifactReadFailed, "Artifact read failed."),
  ArtifactWriteRejected: (error) => cliError(CliErrorCode.ArtifactWriteRejected, error.reason),
  TaskPackageNotFound: (error) => cliError(CliErrorCode.TaskNotFound, `task not found: ${error.taskId}`),
  JournalUnavailable: (error) => {
    const cause = journalUnavailableCause(error.cause);
    return cliError(CliErrorCode.JournalUnavailable, cause ? `Journal is unavailable: ${cause}` : "Journal is unavailable.");
  }
} satisfies CliErrorMapperByTag;

export function toCliError(error: CliReachableKernelError): CliResult["error"] {
  const mapper = cliErrorMappers[error._tag] as (input: typeof error) => CliResult["error"];
  return mapper(error);
}

function journalUnavailableCause(cause: unknown): string {
  if (cause instanceof Error) return firstLine(cause.message);
  if (typeof cause === "string") return firstLine(cause);
  return "";
}

function firstLine(value: string): string {
  return value.trim().split(/\r?\n/u).find((line) => line.trim().length > 0)?.trim() ?? "";
}
