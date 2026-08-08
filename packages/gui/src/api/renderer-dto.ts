// Renderer-facing DTO seam. The renderer boundary (eslint) forbids the renderer
// from importing kernel/application directly — it must consume the window.harness
// bridge and treat the data it returns as opaque DTOs. This api-layer module is
// allowed to import the kernel/application public barrels and re-exports only the
// projection/payload types the renderer needs, so renderer code depends on
// `../api/renderer-dto` instead of reaching into `../../../kernel`.
export type {
  DecisionProjectionRow,
  DomainStatus,
  EntityAttributionProjection,
  ProjectionWarning,
  RelationType,
  TaskProjectionRow
} from "@harness-anything/kernel";
export type {
  AppendTaskProgressPayload,
  CatalogAdapterEntry,
  CatalogPresetEntry,
  CatalogSnapshotResult,
  CatalogSnapshotSuccess,
  CatalogTemplateEntry,
  CatalogTemplateSelection,
  CatalogVerticalEntry,
  DaemonActiveControlStatus,
  DaemonBuildStatus,
  DaemonControlAcceptedV1,
  DaemonControlErrorV1,
  DaemonControlKind,
  DaemonControlRequestV1,
  DaemonLogEntryV1,
  DaemonLogListInputV1,
  DaemonLogPageV1,
  DaemonQueueStatus,
  DaemonReconcileErrorStatus,
  DaemonRendererRepoStatus,
  DaemonRendererStatusV2,
  DecisionDetailResult,
  DecisionIdPayload,
  DecisionListResult,
  DecisionMutationResult,
  DecisionProposePayload,
  DecisionTransitionPayload,
  ExecutionDetailResult,
  ExecutionEvidenceCursor,
  ExecutionEvidenceExecutionRow,
  ExecutionEvidenceOutputRow,
  ExecutionEvidencePagePayload,
  ExecutionEvidencePageResult,
  ExecutionEvidenceStats,
  ExecutionEvidenceTaskGroup,
  ExecutionIdPayload,
  ExecutionProjectionRow,
  FactAnchorRow,
  FactListResult,
  FactProjectionRow,
  LocalControllerResult,
  PeripheralDocumentListResult,
  PeripheralDocumentPayload,
  PeripheralDocumentResult,
  ProjectionJsonObject,
  ProjectionJsonValue,
  RelationCoverageRow,
  RelationGraphEdgeRow,
  RelationGraphReadResult,
  SetTaskStatusPayload,
  TaskDetailResult,
  TaskDocumentPayload,
  TaskDocumentResult,
  TaskExecutionListResult,
  TaskExecutionListSuccess,
  TaskIdPayload,
  TaskFactListResult,
  TaskListResult,
  TriadicProjectionResult,
  AgentRuntimeProfilesResult,
  AgentRuntimeSessionResult,
  AgentRuntimeStatusResult,
  AgentRuntimeEventsResult,
  AgentRuntimeResultResult,
  AgentRuntimeSpawnPayload
} from "@harness-anything/application";

import type {
  AgentRuntimeProfilesResult as AgentRuntimeProfilesResultType,
  AgentRuntimeStatusResult as AgentRuntimeStatusResultType,
  AgentRuntimeEventsResult as AgentRuntimeEventsResultType,
  AgentRuntimeResultResult as AgentRuntimeResultResultType
} from "@harness-anything/application";

// Agent runtime nested projection shapes — derived from the result types the
// application barrel already re-exports, so the renderer can stay on opaque
// DTOs without reaching into the agent-runtime-control subpath directly.
export type AgentRuntimeSessionStatus = AgentRuntimeStatusResultType["sessions"][number];
export type AgentRuntimeEventProjection = AgentRuntimeEventsResultType["events"][number];
export type AgentRuntimeResultProjection = AgentRuntimeResultResultType["result"];
export type AgentRuntimeAuthProfile = AgentRuntimeProfilesResultType["profiles"][number];
export type AgentRuntimeControlFailure =
  | Extract<AgentRuntimeStatusResultType, { readonly ok: false }>
  | { readonly ok: false; readonly error: { readonly code: string; readonly hint: string } };
