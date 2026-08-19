import type { DaemonGuiActionResult, DaemonGuiReadPayloadMap, DaemonGuiReadResultMap, DaemonGuiStreamPayloadMap, GuiSubmissionV1 } from "../../../daemon/src/protocol/daemon-protocol.contract.ts";
export type {
  DecisionProjectionRow,
  ProjectionWarning,
  RelationType,
  FactProjectionRow, FactAnchorRow, RelationFactRow,
  RelationCoverageRow,
  RelationGraphEdgeRow
} from "../../../kernel/src/index.ts";
export type TaskSnapshotProjectionRow = DaemonGuiReadResultMap["repo.tasks.list"]["rows"][number]; export type TaskDocumentProjectionRead = DaemonGuiReadResultMap["repo.tasks.document.read"]; export type TaskDocumentListProjectionRead = DaemonGuiReadResultMap["repo.tasks.documents.list"]; export type AgentRuntimeOverviewPayload = DaemonGuiReadPayloadMap["repo.agentRuntime.overview"]; export type AgentRuntimeSessionPayload = DaemonGuiReadPayloadMap["repo.agentRuntime.sessions.read"]; export type AgentRuntimeEventsPayload = DaemonGuiReadPayloadMap["repo.agentRuntime.events.read"]; export type AgentRuntimeAttachPayload = DaemonGuiStreamPayloadMap["repo.agentRuntime.attach"];
export type GuiActionResult = DaemonGuiActionResult; export type GuiBridgeMethod = (typeof import("../../../daemon/src/protocol/daemon-protocol.contract.ts").daemonGuiReadMethods)[number]["guiBridgeMethod"] | (typeof import("../../../daemon/src/protocol/daemon-protocol.contract.ts").daemonGuiActionMethods)[number]["guiBridgeMethod"] | (typeof import("../../../daemon/src/protocol/daemon-protocol.contract.ts").daemonGuiStreamFacets)[number]["guiBridgeMethod"] | "listRuntimeInstances" | "showRuntimeInstance" | "createRuntimeInstance" | "updateRuntimeInstance" | "deleteRuntimeInstance" | "validateRuntimeInstanceAuth" | "signInRuntimeInstance" | "reauthRuntimeInstance" | "signOutRuntimeInstance";
export type { GuiSubmissionV1 };
