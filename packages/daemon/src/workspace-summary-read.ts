import { summarizeWorkspace } from "../../kernel/src/index.ts";
import type { DaemonGuiReadResultMap, DaemonWorkspaceSummaryResult } from "./protocol/daemon-protocol.contract.ts";

export function workspaceSummaryFromReads(
  taskRead: DaemonGuiReadResultMap["repo.tasks.list"],
  decisionRead: DaemonGuiReadResultMap["repo.decisions.list"]
): DaemonWorkspaceSummaryResult {
  const tasks = taskRead.rows.map((row) => ({
    coordinationStatus: row.coordinationStatus,
    packageDisposition: row.placement.packageDisposition
  }));
  const decisions = decisionRead.decisions.map((decision) => ({ decisionId: decision.decisionId, state: decision.state }));

  return {
    schema: "daemon.workspace-summary/v1",
    ok: true,
    status: taskRead.status,
    ...summarizeWorkspace(tasks, decisions),
    watermark: taskRead.watermark,
    sourceRevision: taskRead.sourceRevision,
    warnings: decisionRead.warnings
  };
}
