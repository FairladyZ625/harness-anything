import type { ArtifactStoreError, EngineError, WriteError } from "@harness-anything/kernel";
import { cliError, CliErrorCode, isCliErrorCode } from "./error-codes.ts";
import { productionAuthorityIngressFor, productionAuthorityUnsupportedHint } from "./command-spec/index.ts";
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
  Timeout: (error) => cliError(
    CliErrorCode.Timeout,
    `Operation timed out after ${error.ms}ms. Retry the command; if it repeats, run 'ha doctor --json' and inspect engine or daemon connectivity.`
  ),
  WriteConflict: (error) => cliError(CliErrorCode.WriteConflict, error.owner ?? "Write lock is held."),
  GlobalWriteConflict: (error) => cliError(
    CliErrorCode.WriteConflict,
    `${error.owner ? `Global write lock is held: ${error.owner}` : "Global write lock is held."} Direct recovery remains mutually exclusive with a live daemon; stop or drain the current writer and verify with 'ha daemon status' before retrying.`
  ),
  WriteRejected: (error) => error.code && isCliErrorCode(error.code)
    ? cliError(
      error.code,
      error.code === CliErrorCode.ModuleNotFound
        ? authorityModuleNotFoundPresentation(error.reason)
        : authorityIngressPresentation(error.reason),
      error.context
    )
    : error.reason.includes("authored root is not isolated from the outer code repository")
      ? cliError(CliErrorCode.JournalUnavailable, `Journal is unavailable: ${error.reason}`)
      : cliError(CliErrorCode.WriteRejected, error.reason),
  ArtifactReadFailed: (error) => cliError(
    CliErrorCode.ArtifactReadFailed,
    `Required artifact could not be read at ${error.path}. Restore or create that path, then retry the same command.`
  ),
  ArtifactWriteRejected: (error) => cliError(CliErrorCode.ArtifactWriteRejected, error.reason),
  TaskPackageNotFound: (error) => cliError(CliErrorCode.TaskNotFound, `task not found: ${error.taskId}`),
  JournalUnavailable: (error) => {
    const cause = journalUnavailableCause(error.cause);
    const summary = cause ? `Journal is unavailable: ${cause.replace(/[.\s]+$/u, "")}` : "Journal is unavailable";
    return cliError(
      CliErrorCode.JournalUnavailable,
      `${summary}. Run 'ha doctor --json' to inspect journal and daemon health, then retry the command.`
    );
  }
} satisfies CliErrorMapperByTag;

export function toCliError(error: CliReachableKernelError): CliResult["error"] {
  const mapper = cliErrorMappers[error._tag] as (input: typeof error) => CliResult["error"];
  return mapper(error);
}

function authorityIngressPresentation(reason: string): string {
  const prefix = "AUTHORITY_TYPED_COMMAND_UNSUPPORTED:";
  if (!reason.startsWith(prefix)) return reason;
  const rejectedKind = reason.slice(prefix.length);
  return `${prefix} ${productionAuthorityVariantHint(rejectedKind) ?? productionAuthorityUnsupportedHint(rejectedKind)}`;
}

function authorityModuleNotFoundPresentation(reason: string): string {
  const prefix = "AUTHORITY_PRESET_TASK_CREATE_MODULE_NOT_FOUND:";
  if (reason.startsWith(prefix)) return `Module ${reason.slice(prefix.length)} was not found.`;
  return "The selected module was not found.";
}

function productionAuthorityVariantHint(rejectedKind: string): string | undefined {
  const variantStart = rejectedKind.indexOf("[");
  if (variantStart <= 0 || !rejectedKind.endsWith("]")) return undefined;
  const commandKind = rejectedKind.slice(0, variantStart);
  const variant = rejectedKind.slice(variantStart + 1, -1);
  if (!variant) return undefined;
  const disposition = productionAuthorityIngressFor(commandKind);
  const exclusion = disposition?.status === "typed-v2"
    ? disposition.excludedVariants?.[variant]
    : undefined;
  if (!exclusion) return undefined;
  return `production canonical ingress rejected ${commandKind} variant ${variant}: ${exclusion.reason} (${exclusion.decisionRef})`;
}

function journalUnavailableCause(cause: unknown): string {
  if (cause instanceof Error) return firstLine(cause.message);
  if (typeof cause === "string") return firstLine(cause);
  if (cause && typeof cause === "object" && "message" in cause && typeof cause.message === "string") {
    return firstLine(cause.message);
  }
  return "";
}

function firstLine(value: string): string {
  return value.trim().split(/\r?\n/u).find((line) => line.trim().length > 0)?.trim() ?? "";
}
