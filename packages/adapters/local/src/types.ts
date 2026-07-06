import type { Effect } from "effect";
import type { DomainStatus, EngineError, PackageDisposition, PriorityTier, TaskId, TaskWorkKind, WriteError } from "../../../kernel/src/index.ts";
import type { HarnessLayoutOverrides } from "../../../kernel/src/index.ts";
import type { ProvenancePayload, WriteCoordinator } from "../../../kernel/src/index.ts";
import type { TaskCreatedBy } from "./created-by.ts";

export interface LocalJournalActor {
  readonly kind: "agent" | "human" | "system";
  readonly id: string;
}

export interface LocalLifecycleOptions {
  readonly rootDir: string;
  readonly layoutOverrides?: HarnessLayoutOverrides;
  readonly coordinator?: WriteCoordinator;
  readonly clock?: () => Date;
  readonly bindCreateProvenance?: (boundAt: string) => Effect.Effect<ProvenancePayload | undefined, CreateProvenanceRejected>;
}

export interface CreateProvenanceRejected {
  readonly reason: string;
}

export interface LocalWriteCoordinatorOptions {
  readonly rootDir: string;
  readonly layoutOverrides?: HarnessLayoutOverrides;
  readonly actor?: LocalJournalActor;
  readonly sessionId?: string;
  readonly autoMaterialize?: boolean;
}

export interface CreateLocalTaskInput {
  readonly taskId: TaskId;
  readonly title: string;
  readonly allowManualId?: boolean;
  readonly slug?: string;
  readonly parent?: TaskId;
  readonly workKind?: TaskWorkKind;
  readonly riskTier?: PriorityTier;
  readonly urgency?: PriorityTier;
  readonly vertical?: string;
  readonly preset?: string;
  readonly createdBy?: TaskCreatedBy;
}

export interface SetLocalStatusInput {
  readonly taskId: TaskId;
  readonly status: DomainStatus;
}

export interface AppendProgressInput {
  readonly taskId: TaskId;
  readonly text: string;
}

export interface StageTaskDocumentInput {
  readonly taskId: TaskId;
  readonly path: string;
}

export interface StageTaskTreeInput {
  readonly taskId: TaskId;
}

export interface LocalTaskTreeStatusResult {
  readonly taskId: TaskId;
  readonly dirty: boolean;
  readonly entries: ReadonlyArray<string>;
}

export interface WriteTaskDocumentInput extends StageTaskDocumentInput {
  readonly body: string;
}

export interface TaskReasonInput {
  readonly taskId: TaskId;
  readonly reason: string;
}

export interface SupersedeTaskInput {
  readonly oldTaskId: TaskId;
  readonly newTaskId: TaskId;
  readonly title: string;
  readonly slug: string;
  readonly reason: string;
}

export type DeleteMode = "soft" | "hard";

export interface DeleteTaskInput extends TaskReasonInput {
  readonly mode: DeleteMode;
}

export interface LocalTaskResult {
  readonly taskId: TaskId;
  readonly status: DomainStatus;
  readonly engine: "local";
  readonly packageDisposition?: PackageDisposition;
}

export interface LocalProgressResult {
  readonly taskId: TaskId;
  readonly path: string;
}

export interface LocalSupersedeResult {
  readonly oldTaskId: TaskId;
  readonly newTaskId: TaskId;
  readonly packageDisposition: "archived";
}

export interface LocalDeleteResult {
  readonly taskId: TaskId;
  readonly mode: DeleteMode;
  readonly packageDisposition?: "tombstoned";
}

export interface LocalLifecycleEngine {
  readonly createTask: (input: CreateLocalTaskInput) => Effect.Effect<LocalTaskResult, EngineError | WriteError>;
  readonly setStatus: (input: SetLocalStatusInput) => Effect.Effect<LocalTaskResult, EngineError | WriteError>;
  readonly appendProgress: (input: AppendProgressInput) => Effect.Effect<LocalProgressResult, EngineError | WriteError>;
  readonly stageDocument: (input: StageTaskDocumentInput) => Effect.Effect<LocalProgressResult, EngineError | WriteError>;
  readonly stageTaskTree: (input: StageTaskTreeInput) => Effect.Effect<LocalProgressResult, EngineError | WriteError>;
  readonly taskTreeStatus: (input: StageTaskTreeInput) => Effect.Effect<LocalTaskTreeStatusResult, EngineError | WriteError>;
  readonly replaceTaskDocument: (input: WriteTaskDocumentInput) => Effect.Effect<LocalProgressResult, EngineError | WriteError>;
  readonly archiveTask: (input: TaskReasonInput) => Effect.Effect<LocalTaskResult, EngineError | WriteError>;
  readonly supersedeTask: (input: SupersedeTaskInput) => Effect.Effect<LocalSupersedeResult, EngineError | WriteError>;
  readonly deleteTask: (input: DeleteTaskInput) => Effect.Effect<LocalDeleteResult, EngineError | WriteError>;
  readonly reopenTask: (input: TaskReasonInput) => Effect.Effect<LocalTaskResult, EngineError | WriteError>;
}

export interface LocalTaskIndex {
  readonly taskId: TaskId;
  readonly title: string;
  readonly parent?: TaskId;
  readonly engine: string;
  readonly status: DomainStatus;
  readonly ref: string | null;
  readonly titleSnapshot: string | null;
  readonly url: string | null;
  readonly bindingCreatedAt: string;
  readonly bindingFingerprint: string;
  readonly packageDisposition: "active" | "archived" | "tombstoned";
  readonly workKind?: TaskWorkKind;
  readonly riskTier?: PriorityTier;
  readonly urgency?: PriorityTier;
  readonly vertical: string;
  readonly preset: string;
  readonly provenance: ReadonlyArray<ProvenancePayload>;
  readonly profile?: string;
  readonly createdBy?: TaskCreatedBy;
}
