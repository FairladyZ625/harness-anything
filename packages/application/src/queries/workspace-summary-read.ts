import type { DecisionProjectionRow, DomainStatus, ProjectionWarning, TaskProjection } from "@harness-anything/kernel";
import { summarizeWorkspace } from "@harness-anything/kernel/internal/domain/workspace-summary.ts";
import type { TaskPackageDisposition } from "@harness-anything/kernel/internal/domain/task.ts";
import type * as ProjectionStatus from "@harness-anything/kernel/internal/domain/task-read-set.ts";
import type { WorkspaceSummaryResult } from "./query-ports.ts";

export function workspaceSummaryFromProjection(projection: TaskProjection): WorkspaceSummaryResult {
  return workspaceSummaryFromProjectionRead(projection.readWorkspaceSummary());
}

export function workspaceSummaryFromProjectionRead(
  read: ReturnType<TaskProjection["readWorkspaceSummary"]>,
): WorkspaceSummaryResult {
  return {
    schema: "daemon.workspace-summary/v1",
    ok: true,
    status: read.status,
    ...read.summary,
    watermark: read.watermark,
    sourceRevision: read.sourceRevision,
    warnings: [],
  };
}

/** Frozen canonical-event compatibility adapter. Production reads use the native projection path above. */
export function workspaceSummaryFromReads(
  taskRead: {
    readonly status: ProjectionStatus.ReadSetProjectionCut["status"];
    readonly watermark: number;
    readonly sourceRevision: number;
    readonly rows: readonly {
      readonly updatedAt: string;
      readonly coordinationStatus: DomainStatus;
      readonly placement: { readonly packageDisposition: TaskPackageDisposition };
    }[];
  },
  decisionRead: {
    readonly warnings: readonly ProjectionWarning[];
    readonly decisions: readonly {
      readonly decisionId: string;
      readonly state: DecisionProjectionRow["state"];
    }[];
  },
): WorkspaceSummaryResult {
  return {
    schema: "daemon.workspace-summary/v1",
    ok: true,
    status: taskRead.status,
    ...summarizeWorkspace(
      taskRead.rows.map((row) => ({
        updatedAt: row.updatedAt,
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
