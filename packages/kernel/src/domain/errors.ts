import type { EngineId, ExternalRef, TaskId } from "./task.js";

export type EngineError =
  | { readonly _tag: "EngineNotEnabled"; readonly engine: EngineId }
  | { readonly _tag: "AdapterUnavailable"; readonly engine: EngineId; readonly cause?: unknown }
  | { readonly _tag: "AuthMissing"; readonly engine: EngineId }
  | { readonly _tag: "RefNotFound"; readonly ref: ExternalRef }
  | { readonly _tag: "MalformedSnapshot"; readonly raw: unknown }
  | { readonly _tag: "StatusUnmapped"; readonly rawStatus: string }
  | { readonly _tag: "EngineOwnsStatus"; readonly engine: EngineId; readonly ref: ExternalRef }
  | { readonly _tag: "RateLimited"; readonly engine: EngineId; readonly retryAfterMs?: number }
  | { readonly _tag: "EngineUnreachable"; readonly engine: EngineId; readonly cause?: unknown }
  | { readonly _tag: "Timeout"; readonly ms: number };

export type BindingInvariantError = {
  readonly _tag: "BindingInvariantViolation";
  readonly taskId: TaskId;
  readonly field: "engine" | "ref" | "bindingCreatedAt" | "bindingFingerprint";
  readonly expected: string | null;
  readonly actual: string | null;
};

export type ArtifactStoreError =
  | { readonly _tag: "TaskPackageNotFound"; readonly taskId: TaskId }
  | { readonly _tag: "ArtifactReadFailed"; readonly path: string; readonly cause?: unknown }
  | { readonly _tag: "ArtifactWriteRejected"; readonly path: string; readonly reason: string };

export type TemplateLibraryError =
  | { readonly _tag: "TemplateNotFound"; readonly templateId: string; readonly locale?: string }
  | { readonly _tag: "TemplateCatalogInvalid"; readonly reason: string };

export type WriteError =
  | { readonly _tag: "WriteRejected"; readonly taskId: TaskId; readonly reason: string }
  | { readonly _tag: "WriteConflict"; readonly taskId: TaskId; readonly owner?: string }
  | { readonly _tag: "JournalUnavailable"; readonly cause?: unknown };
