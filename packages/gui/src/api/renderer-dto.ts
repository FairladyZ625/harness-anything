import type { DaemonGuiReadResultMap } from "../../../daemon/src/protocol/daemon-protocol.contract.ts";

export type {
  DecisionProjectionRow,
  ProjectionWarning,
  RelationType,
  FactAnchorRow,
  RelationCoverageRow,
  RelationGraphEdgeRow
} from "../../../kernel/src/index.ts";

export type TaskSnapshotProjectionRow = DaemonGuiReadResultMap["repo.tasks.list"]["rows"][number]; export type TaskDocumentProjectionRead = DaemonGuiReadResultMap["repo.tasks.document.read"];
export type GuiBridgeMethod = (typeof import("../../../daemon/src/protocol/daemon-protocol.contract.ts").daemonGuiReadMethods)[number]["guiBridgeMethod"];
