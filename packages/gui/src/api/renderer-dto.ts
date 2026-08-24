import type {
  DaemonGuiActionResult,
  DaemonGuiReadPayloadMap,
  DaemonGuiReadResultMap,
  DaemonGuiStreamPayloadMap,
  GuiSubmissionV1,
} from "../../../daemon/src/protocol/daemon-protocol.contract.ts";
export type {
  DecisionProjectionRow,
  ProjectionWarning,
  RelationType,
  FactProjectionRow,
  FactAnchorRow,
  RelationFactRow,
  RelationGraphEdgeRow,
  FreshnessReason,
} from "../../../kernel/src/index.ts";
/**
 * The coverage row the daemon read actually serves: the kernel projection row plus
 * the optional uncovered-cause classification (kernel `freshnessReasonOf`) attached
 * by the read surface. Typed from the served shape, not the kernel shape, so the
 * renderer consumes the judgment instead of re-deriving it.
 */
export type RelationCoverageRow = DaemonGuiReadResultMap["repo.triadic.relationGraph"]["coverageRows"][number];
export type TaskSnapshotProjectionRow = DaemonGuiReadResultMap["repo.tasks.list"]["rows"][number];
export type WorkspaceSummaryRead = DaemonGuiReadResultMap["repo.workspace.summary.read"];
export type TaskDocumentProjectionRead = DaemonGuiReadResultMap["repo.tasks.document.read"];
export type TaskDocumentListProjectionRead = DaemonGuiReadResultMap["repo.tasks.documents.list"];
export type TaskDispatchesRead = DaemonGuiReadResultMap["repo.task.dispatches"];
export type TaskDispatchProjectionRow = DaemonGuiReadResultMap["repo.task.dispatches"]["dispatches"][number];
export type AgentRuntimeOverviewPayload = DaemonGuiReadPayloadMap["repo.agentRuntime.overview"];
export type AgentRuntimeSessionPayload = DaemonGuiReadPayloadMap["repo.agentRuntime.sessions.read"];
export type AgentRuntimeEventsPayload = DaemonGuiReadPayloadMap["repo.agentRuntime.events.read"];
export type AgentRuntimeAttachPayload = DaemonGuiStreamPayloadMap["repo.agentRuntime.attach"];
export type GuiActionResult = DaemonGuiActionResult;
export type GuiBridgeMethod =
  | (typeof import("../../../daemon/src/protocol/daemon-protocol.contract.ts").daemonGuiInvokeFacets)[number]["guiBridgeMethod"]
  | (typeof import("../../../daemon/src/protocol/daemon-protocol.contract.ts").daemonGuiStreamFacets)[number]["guiBridgeMethod"];
export type { GuiSubmissionV1 };
