import { summarizeWorkspace, type TaskProjection } from "../../kernel/src/index.ts";
import type { DaemonGuiReadResultMap, DaemonWorkspaceSummaryResult } from "./protocol/daemon-protocol.contract.ts";

export function workspaceSummaryFromProjection(projection: TaskProjection): DaemonWorkspaceSummaryResult {
  const read = projection.readWorkspaceSummary();
  return {
    schema: "daemon.workspace-summary/v1",
    ok: true,
    status: read.status,
    ...read.summary,
    watermark: read.watermark,
    sourceRevision: read.sourceRevision,
    warnings: []
  };
}

/** Frozen canonical-event compatibility adapter. Production reads use the native projection path above. */
export function workspaceSummaryFromReads(
  taskRead: DaemonGuiReadResultMap["repo.tasks.list"],
  decisionRead: DaemonGuiReadResultMap["repo.decisions.list"],
): DaemonWorkspaceSummaryResult {
  return {
    schema: "daemon.workspace-summary/v1",
    ok: true,
    status: taskRead.status,
    ...summarizeWorkspace(
      taskRead.rows.map((row) => ({
        coordinationStatus: row.coordinationStatus,
        packageDisposition: row.placement.packageDisposition,
      })),
      decisionRead.decisions.map((decision) => ({ decisionId: decision.decisionId, state: decision.state })),
    ),
    watermark: taskRead.watermark,
    sourceRevision: taskRead.sourceRevision,
    warnings: decisionRead.warnings,
  };
}
