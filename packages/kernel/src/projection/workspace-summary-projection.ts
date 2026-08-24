import type { DatabaseSync } from "node:sqlite";
import { blockingOf } from "../domain/task-blocking.ts";
import { isDomainStatus } from "../domain/lifecycle-status.ts";
import { summarizeWorkspace, workspaceTaskStatus, type WorkspaceSummary } from "../domain/workspace-summary.ts";
import type { PackageDisposition } from "../domain/package-disposition.ts";
import type { DecisionState } from "../domain/decision-event.ts";
import { readTaskRelationPage } from "./task-query-projection.ts";

interface TaskCensusRow {
  readonly task_id: string;
  readonly status: string | null;
  readonly package_disposition: PackageDisposition;
}

/** Workspace census from narrow projection columns. Domain judgments stay in the
 * domain; this read only removes full task/decision DTO materialization. */
export function readWorkspaceSummaryRows(db: DatabaseSync): WorkspaceSummary {
  const taskRows = db.prepare([
    "SELECT task_id, status,",
    "COALESCE(json_extract(snapshot_json, '$.task.packageDisposition'), 'active') AS package_disposition",
    "FROM task_snapshot ORDER BY task_id",
  ].join(" ")).all() as unknown as readonly TaskCensusRow[];
  const dependencyRows: Array<ReturnType<typeof readTaskRelationPage>["rows"][number]> = [];
  let relationCursor: string | undefined;
  do {
    const page = readTaskRelationPage(db, {
      relationType: "depends-on",
      limit: 500,
      ...(relationCursor ? { cursor: relationCursor } : {}),
    });
    dependencyRows.push(...page.rows);
    relationCursor = page.page?.nextCursor ?? undefined;
  } while (relationCursor !== undefined);
  const blocking = new Map(blockingOf(
    taskRows.map((row) => ({ taskId: row.task_id, status: row.status ?? "unknown" })),
    dependencyRows,
  ).map((row) => [row.taskId, row.state]));
  const tasks = taskRows.map((row) => ({
    coordinationStatus: row.status !== null && isDomainStatus(row.status)
      ? workspaceTaskStatus({ status: row.status, blockingState: blocking.get(row.task_id) ?? "unknown" })
      : "unknown" as const,
    packageDisposition: row.package_disposition,
  }));
  const decisions = (db.prepare(
    "SELECT decision_id, state FROM decision ORDER BY decision_id",
  ).all() as unknown as readonly {
    readonly decision_id: string;
    readonly state: DecisionState;
  }[]).map((row) => ({ decisionId: row.decision_id, state: row.state }));
  return summarizeWorkspace(tasks, decisions);
}
