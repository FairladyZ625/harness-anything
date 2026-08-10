import type { Effect } from "effect";
import type {
  ArtifactStore,
  EngineError,
  HarnessLayoutOverrides,
  WriteControl
} from "@harness-anything/kernel";
import type { AgentRuntimeControlService } from "./agent-runtime-control.ts";
import type { AgentHolderProjectionService } from "./agent-holder-projection.ts";
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
import type { ReadTaskReturnToIdeaSnapshotV1 } from "./authority/task-return-to-idea-policy.ts";

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
  readonly agentHolderProjection?: AgentHolderProjectionService;
  readonly readTaskReturnToIdeaSnapshot?: ReadTaskReturnToIdeaSnapshotV1;
}
export interface LocalControllerProjectionQueries {
  readonly getExecutionEvidencePage: (
    payload: ExecutionEvidencePagePayload
  ) => Promise<ExecutionEvidencePageResult>;
}

export interface LocalControllerStatusWriteResult {
  readonly taskId: string;
  readonly status: import("@harness-anything/kernel").DomainStatus;
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
  readonly setStatus: (payload: SetTaskStatusPayload) => Effect.Effect<LocalControllerStatusWriteResult, EngineError | WriteControl>;
  readonly appendProgress: (payload: AppendTaskProgressPayload) => Effect.Effect<LocalControllerProgressWriteResult, EngineError | WriteControl>;
  readonly stageDocument: (payload: TaskDocumentPayload) => Effect.Effect<LocalControllerProgressWriteResult, EngineError | WriteControl>;
  readonly stageTaskTree: (payload: TaskIdPayload) => Effect.Effect<LocalControllerProgressWriteResult, EngineError | WriteControl>;
  readonly taskTreeStatus: (payload: TaskIdPayload) => Effect.Effect<LocalControllerTaskTreeStatusResult, EngineError | WriteControl>;
}
