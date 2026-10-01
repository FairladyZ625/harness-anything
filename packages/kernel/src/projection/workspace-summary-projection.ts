import type { DatabaseSync } from "node:sqlite";
import { blockingOf } from "../domain/task-blocking.ts";
import { isDomainStatus } from "../domain/lifecycle-status.ts";
import {
  emptyWorkspaceTaskCounts,
  summarizeWorkspaceCensus,
  workspaceTaskStatus,
  type WorkspaceSummary,
} from "../domain/workspace-summary.ts";
import type { DecisionState } from "../domain/decision-event.ts";
import { queryRows, type ProjectionSqlRow } from "./rebuildable-task-projection-sql.ts";
import { readTaskRelationPage } from "./task-query-projection.ts";

/** Workspace census counted in SQL. Only a task some blocking relation names can have a
 * coordinationStatus other than its status, so only those endpoints are read row by row and
 * judged in the domain; every other task and every decision is counted by group. */
export function readWorkspaceSummaryRows(db: DatabaseSync): WorkspaceSummary {
  const activePackageTasks = emptyWorkspaceTaskCounts();
  let lastChangedAt: string | null = null;
  for (const row of queryRows<
    { readonly status: string | null; readonly count: number; readonly last_changed_at: string } & ProjectionSqlRow
  >(
    db,
    "SELECT status, COUNT(*) AS count, MAX(updated_at) AS last_changed_at FROM task_snapshot WHERE package_disposition = 'active' GROUP BY status",
  )) {
    activePackageTasks[row.status !== null && isDomainStatus(row.status) ? row.status : "unknown"] += row.count;
    if (lastChangedAt === null || row.last_changed_at > lastChangedAt) lastChangedAt = row.last_changed_at;
  }

  const blockingRelations: Array<ReturnType<typeof readTaskRelationPage>["rows"][number]> = [];
  for (const relationType of ["depends-on", "awaits"] as const) {
    let relationCursor: string | undefined;
    do {
      const page = readTaskRelationPage(db, {
        relationType,
        limit: 500,
        ...(relationCursor ? { cursor: relationCursor } : {}),
      });
      blockingRelations.push(...page.rows);
      relationCursor = page.page?.nextCursor ?? undefined;
    } while (relationCursor !== undefined);
  }
  const endpointIds = [
    ...new Set(
      blockingRelations.flatMap(({ sourceRef, targetRef }) =>
        [sourceRef, targetRef].filter((ref) => ref.startsWith("task/")).map((ref) => ref.slice("task/".length)),
      ),
    ),
  ];
  const endpoints = endpointIds.length
    ? queryRows<
        {
          readonly task_id: string;
          readonly status: string | null;
          readonly package_disposition: string;
        } & ProjectionSqlRow
      >(
        db,
        "SELECT task_id, status, package_disposition FROM task_snapshot WHERE task_id IN (SELECT value FROM json_each(?)) ORDER BY task_id",
        JSON.stringify(endpointIds),
      )
    : [];
  const blocking = new Map(
    blockingOf(
      endpoints.map((row) => ({ taskId: row.task_id, status: row.status ?? "unknown" })),
      blockingRelations,
    ).map((row) => [row.taskId, row.state]),
  );
  for (const row of endpoints) {
    if (row.package_disposition !== "active" || row.status === null || !isDomainStatus(row.status)) continue;
    const coordinationStatus = workspaceTaskStatus({
      status: row.status,
      blockingState: blocking.get(row.task_id) ?? "unknown",
    });
    activePackageTasks[row.status] -= 1;
    activePackageTasks[coordinationStatus] += 1;
  }

  const decisions = queryRows<{ readonly state: DecisionState; readonly decision_ids: string } & ProjectionSqlRow>(
    db,
    "SELECT state, json_group_array(decision_id ORDER BY decision_id) AS decision_ids FROM decision GROUP BY state",
  )
    .flatMap((row) =>
      (JSON.parse(row.decision_ids) as string[]).map((decisionId) => ({ decisionId, state: row.state })),
    )
    // Decision ids are ASCII (`dec_[A-Za-z0-9_-]+`), so code-unit order is SQLite's BINARY order.
    .sort((left, right) => (left.decisionId < right.decisionId ? -1 : left.decisionId > right.decisionId ? 1 : 0));
  return summarizeWorkspaceCensus(activePackageTasks, decisions, lastChangedAt);
}
