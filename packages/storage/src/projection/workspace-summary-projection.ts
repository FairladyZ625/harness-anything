import { storageReadPolicy } from "@harness-anything/kernel/internal/domain/storage-read-policy.ts";
import type { DatabaseSync } from "node:sqlite";
import { blockingOf } from "@harness-anything/kernel/internal/domain/task-blocking.ts";
import { isDomainStatus } from "@harness-anything/kernel/internal/domain/lifecycle-status.ts";
import {
  emptyWorkspaceTaskCounts,
  summarizeWorkspaceCensus,
  workspaceTaskStatus,
  type WorkspaceSummary,
} from "@harness-anything/kernel/internal/domain/workspace-summary.ts";
import type { DecisionState } from "@harness-anything/kernel/internal/domain/decision-event.ts";
import { queryRows, type ProjectionSqlRow } from "./rebuildable-task-projection-sql.ts";
import { readTaskRelationPage } from "./task-query-projection.ts";

/** Workspace census counted in SQL. Only a task some blocking relation names can have a
 * coordinationStatus other than its status, so only those endpoints are read row by row and
 * judged in the domain; every other task and every decision is counted by group. */
export function readWorkspaceSummaryRows(db: DatabaseSync): WorkspaceSummary {
  const activePackageTasks = emptyWorkspaceTaskCounts();
  for (const row of queryRows<{ readonly status: string | null; readonly count: number } & ProjectionSqlRow>(
    db,
    "SELECT status, count FROM workspace_task_census",
  )) {
    activePackageTasks[row.status !== null && isDomainStatus(row.status) ? row.status : "unknown"] += row.count;
  }
  const lastChangedAt =
    queryRows<{ readonly updated_at: string }>(
      db,
      "SELECT updated_at FROM task_snapshot WHERE package_disposition='active' ORDER BY updated_at DESC LIMIT 1",
    )[0]?.updated_at ?? null;

  const blockingRelations: Array<ReturnType<typeof readTaskRelationPage>["rows"][number]> = [];
  // Only a current task whose status can change to blocked can change the census. Start
  // there and follow its dependency component; disconnected historical edges contribute nothing.
  const sources = new Set(
    queryRows<{ readonly task_id: string }>(
      db,
      `SELECT task_id FROM task_snapshot INDEXED BY task_snapshot_active_package
    WHERE package_disposition='active' AND status IN ('planned','active') AND (
      EXISTS (SELECT 1 FROM relation_edge WHERE source_ref='task/' || task_snapshot.task_id AND relation_type IN ('depends-on','awaits') AND state='active')
      OR EXISTS (SELECT 1 FROM task_relation WHERE source_ref='task/' || task_snapshot.task_id AND relation_type IN ('depends-on','awaits') AND state='active')
    )`,
    ).map(({ task_id }) => `task/${task_id}`),
  );
  for (const source of sources)
    for (const relationType of ["depends-on", "awaits"] as const) {
      let relationCursor: string | undefined;
      do {
        const page = readTaskRelationPage(db, {
          relationType,
          source,
          state: "active",
          limit: storageReadPolicy.defaultValue.pageSizes.standard,
          ...(relationCursor ? { cursor: relationCursor } : {}),
        });
        blockingRelations.push(...page.rows);
        for (const edge of page.rows) if (/^task\/[^/]+$/u.test(edge.targetRef)) sources.add(edge.targetRef);
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
