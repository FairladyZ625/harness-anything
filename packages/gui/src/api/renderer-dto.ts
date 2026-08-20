import type { DaemonGuiActionResult, DaemonGuiReadPayloadMap, DaemonGuiReadResultMap, DaemonGuiStreamPayloadMap, GuiSubmissionV1 } from "@harness-anything/daemon/protocol/daemon-protocol.contract";
export type {
  DecisionProjectionRow,
  ProjectionWarning,
  RelationType,
  FactProjectionRow, FactAnchorRow, RelationFactRow,
  RelationCoverageRow,
  RelationGraphEdgeRow
} from "@harness-anything/kernel";
export type TaskSnapshotProjectionRow = DaemonGuiReadResultMap["repo.tasks.list"]["rows"][number]; export type TaskDocumentProjectionRead = DaemonGuiReadResultMap["repo.tasks.document.read"]; export type TaskDocumentListProjectionRead = DaemonGuiReadResultMap["repo.tasks.documents.list"]; export type TaskDispatchesRead = DaemonGuiReadResultMap["repo.task.dispatches"]; export type TaskDispatchProjectionRow = DaemonGuiReadResultMap["repo.task.dispatches"]["dispatches"][number]; export type AgentRuntimeOverviewPayload = DaemonGuiReadPayloadMap["repo.agentRuntime.overview"]; export type AgentRuntimeSessionPayload = DaemonGuiReadPayloadMap["repo.agentRuntime.sessions.read"]; export type AgentRuntimeEventsPayload = DaemonGuiReadPayloadMap["repo.agentRuntime.events.read"]; export type AgentRuntimeAttachPayload = DaemonGuiStreamPayloadMap["repo.agentRuntime.attach"];
export type GuiActionResult = DaemonGuiActionResult; export type GuiBridgeMethod = (typeof import("@harness-anything/daemon/protocol/daemon-protocol.contract").daemonGuiReadMethods)[number]["guiBridgeMethod"] | (typeof import("@harness-anything/daemon/protocol/daemon-protocol.contract").daemonGuiActionMethods)[number]["guiBridgeMethod"] | (typeof import("@harness-anything/daemon/protocol/daemon-protocol.contract").daemonGuiStreamFacets)[number]["guiBridgeMethod"] | "listRuntimeInstances" | "showRuntimeInstance" | "createRuntimeInstance" | "updateRuntimeInstance" | "deleteRuntimeInstance" | "validateRuntimeInstanceAuth" | "signInRuntimeInstance" | "reauthRuntimeInstance" | "signOutRuntimeInstance";
export type { GuiSubmissionV1 };
