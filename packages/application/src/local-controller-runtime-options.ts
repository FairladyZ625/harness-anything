import type { Effect } from "effect";
import type {
  ArtifactStore,
  EngineError,
  HarnessLayoutOverrides,
  WriteError
} from "../../kernel/src/index.ts";
import type { AgentRuntimeControlService } from "./agent-runtime-control.ts";
import type {
  AppendTaskProgressPayload,
  CatalogSnapshotResult,
  ExecutionEvidencePagePayload,
  ExecutionEvidencePageResult,
  LocalControllerDecisionMutationPort,
  SetTaskStatusPayload,
  TaskDocumentPayload,
  TaskIdPayload
} from "./index.ts";

export interface LocalControllerServiceOptions {
  readonly rootDir: string;
  readonly layoutOverrides?: HarnessLayoutOverrides;
  readonly taskWriter: LocalControllerTaskWriter;
  readonly artifactStore: Pick<ArtifactStore, "readTaskPackage" | "listAuthoredDocuments" | "readAuthoredDocument">;
  readonly catalogSnapshotReader?: () => CatalogSnapshotResult;
  readonly decisionMutationPort?: LocalControllerDecisionMutationPort;
  readonly projectionQueries?: LocalControllerProjectionQueries;
  readonly agentRuntimeInventoryReader?: () => Promise<import("./index.ts").AgentRuntimeInventoryResult>;
  readonly agentRuntimeControl?: AgentRuntimeControlService;
}
export interface LocalControllerProjectionQueries {
  readonly getExecutionEvidencePage: (
    payload: ExecutionEvidencePagePayload
  ) => Promise<ExecutionEvidencePageResult>;
}

export interface LocalControllerStatusWriteResult {
  readonly taskId: string;
  readonly status: import("../../kernel/src/index.ts").DomainStatus;
}

export interface LocalControllerProgressWriteResult {
  readonly taskId: string;
  readonly path: string;
}

export interface LocalControllerTaskTreeStatusResult {
  readonly taskId: string;
  readonly dirty: boolean;
  readonly entries: ReadonlyArray<string>;
}

export interface LocalControllerTaskWriter {
  readonly setStatus: (payload: SetTaskStatusPayload) => Effect.Effect<LocalControllerStatusWriteResult, EngineError | WriteError>;
  readonly appendProgress: (payload: AppendTaskProgressPayload) => Effect.Effect<LocalControllerProgressWriteResult, EngineError | WriteError>;
  readonly stageDocument: (payload: TaskDocumentPayload) => Effect.Effect<LocalControllerProgressWriteResult, EngineError | WriteError>;
  readonly stageTaskTree: (payload: TaskIdPayload) => Effect.Effect<LocalControllerProgressWriteResult, EngineError | WriteError>;
  readonly taskTreeStatus: (payload: TaskIdPayload) => Effect.Effect<LocalControllerTaskTreeStatusResult, EngineError | WriteError>;
}
