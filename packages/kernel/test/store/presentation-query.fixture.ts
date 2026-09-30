import { DatabaseSync } from "node:sqlite";
import type { TaskLifecycleSnapshot } from "../../src/domain/task-lifecycle.contract.ts";
import {
  readTaskIndexRows,
  readTaskPresentationStatus,
  type TaskProjectionListQuery,
} from "../../src/projection/task-query-projection.ts";

/** In-memory SQL fixture shared with daemon presentation tests. */
export function presentationQueryFixture(
  snapshot: TaskLifecycleSnapshot,
  rows: readonly { taskId: string; status: string; updatedAt: string; parentTaskId: string | null }[],
) {
  const db = new DatabaseSync(":memory:");
  db.exec(
    "CREATE TABLE task_snapshot (task_id TEXT PRIMARY KEY, status TEXT, updated_at TEXT, snapshot_json TEXT); CREATE TABLE task_package (task_id TEXT PRIMARY KEY, package_path TEXT)",
  );
  const insert = db.prepare("INSERT INTO task_snapshot VALUES (?, ?, ?, ?)");
  for (const row of rows)
    insert.run(
      row.taskId,
      row.status,
      row.updatedAt,
      JSON.stringify({
        task: {
          ...snapshot.task,
          ...row,
          metadata: {
            parentTaskId: row.parentTaskId,
            idempotencyKey: null,
            workKind: null,
            riskTier: null,
            urgency: null,
            verticalId: "test",
            presetId: "standard-task",
            profileId: "baseline",
            moduleKey: null,
            slug: row.taskId,
            surfaces: [],
            fromLegacyId: null,
          },
        },
      }),
    );
  return {
    db,
    readIndex: (query: TaskProjectionListQuery) => readTaskIndexRows(db, query),
    readStatus: (id: string) => readTaskPresentationStatus(db, id),
  };
}
