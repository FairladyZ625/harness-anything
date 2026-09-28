import type { TaskId } from "./task.js";

export type ArtifactStoreError =
  | { readonly _tag: "TaskPackageNotFound"; readonly taskId: TaskId }
  | { readonly _tag: "ArtifactReadFailed"; readonly path: string; readonly cause?: unknown }
  | { readonly _tag: "ArtifactWriteRejected"; readonly path: string; readonly reason: string };

type TaggedDomainError<Tag extends string, Code extends string> = {
  readonly _tag: Tag;
  readonly code: Code;
  readonly message: string;
};

export type LeaseConflictError = TaggedDomainError<"LeaseConflictError", "lease_conflict">;
export type TaskNotFoundError = TaggedDomainError<"TaskNotFoundError", "task_not_found">;
export type InvalidWritePlanError = TaggedDomainError<"InvalidWritePlanError", "invalid_write_plan">;
export type ProtocolVersionMismatchError = TaggedDomainError<
  "ProtocolVersionMismatchError",
  "incompatible_protocol_version"
>;

export type CoreDomainError =
  | LeaseConflictError
  | TaskNotFoundError
  | InvalidWritePlanError
  | ProtocolVersionMismatchError;

export type NormalizedDomainError =
  | CoreDomainError
  | { readonly _tag: "OtherCodedError"; readonly code: string; readonly message: string }
  | { readonly _tag: "UnclassifiedError"; readonly message: string };

const coreDomainErrorCodes = {
  LeaseConflictError: "lease_conflict",
  TaskNotFoundError: "task_not_found",
  InvalidWritePlanError: "invalid_write_plan",
  ProtocolVersionMismatchError: "incompatible_protocol_version",
} as const satisfies {
  readonly [Error in CoreDomainError as Error["_tag"]]: Error["code"];
};

export function coreDomainError<Tag extends CoreDomainError["_tag"]>(
  tag: Tag,
  message: string,
): Extract<CoreDomainError, { readonly _tag: Tag }> {
  return { _tag: tag, code: coreDomainErrorCodes[tag], message } as Extract<CoreDomainError, { readonly _tag: Tag }>;
}

export function normalizeDomainError(error: unknown): NormalizedDomainError {
  const message = thrownMessage(error),
    code = thrownCode(error);
  switch (code) {
    case "lease_conflict":
      return coreDomainError("LeaseConflictError", message);
    case "task_not_found":
      return coreDomainError("TaskNotFoundError", message);
    case "invalid_write_plan":
      return coreDomainError("InvalidWritePlanError", message);
    case "incompatible_protocol_version":
      return coreDomainError("ProtocolVersionMismatchError", message);
    case null:
      return { _tag: "UnclassifiedError", message };
    default:
      return { _tag: "OtherCodedError", code, message };
  }
}

function thrownCode(error: unknown): string | null {
  return typeof error === "object" && error !== null && "code" in error && typeof error.code === "string"
    ? error.code
    : null;
}

function thrownMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}
