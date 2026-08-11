// Renderer-facing DTO seam. The renderer boundary (eslint) forbids the renderer
// from importing kernel/application directly — it must consume the window.harness
// bridge and treat the data it returns as opaque DTOs. This api-layer module is
// allowed to import the kernel/application public barrels and re-exports only the
// projection/payload types the renderer needs, so renderer code depends on
// `../api/renderer-dto` instead of reaching into `../../../kernel`.
export type {
  DecisionProjectionRow,
  DomainStatus,
  ProjectionWarning,
  RelationType,
  TaskProjectionRow
} from "../../../kernel/src/index.ts";
export type {
  DecisionDetailResult,
  DecisionIdPayload,
  DecisionListResult,
  FactAnchorRow,
  FactProjectionRow,
  RelationCoverageRow,
  RelationGraphEdgeRow,
  RelationGraphReadResult,
  TaskDetailResult,
  TaskDocumentPayload,
  TaskDocumentResult,
  TaskIdPayload,
  TaskFactListResult,
  TaskListResult
} from "../../../application/src/index.ts";
