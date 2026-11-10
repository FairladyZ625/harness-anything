import type { DatabaseSync } from "node:sqlite";
import { queryRows, runSql, transaction } from "./rebuildable-task-projection-sql.ts";

/** Additive cache expansion. Triggers also cover writes from the previous binary. The table,
 * initial census and triggers become visible together, so readers never see a partial count. */
export function ensureWorkspaceTaskCensus(db: DatabaseSync): void {
  runSql(
    db,
    "CREATE INDEX IF NOT EXISTS task_snapshot_active_package ON task_snapshot(task_id) WHERE package_disposition='active'",
  );
  runSql(
    db,
    "CREATE INDEX IF NOT EXISTS task_snapshot_active_latest ON task_snapshot(updated_at DESC) WHERE package_disposition='active'",
  );
  if (queryRows(db, "SELECT 1 FROM sqlite_master WHERE type='table' AND name='workspace_task_census'").length) return;
  transaction(db, () => {
    runSql(
      db,
      "/* @gate-identity state-store/task.projection.workspace_task_census */ CREATE TABLE workspace_task_census (status TEXT PRIMARY KEY, count INTEGER NOT NULL)",
    );
    runSql(
      db,
      `INSERT INTO workspace_task_census SELECT COALESCE(status, 'unknown'), COUNT(*)
      FROM task_snapshot WHERE package_disposition='active' GROUP BY COALESCE(status, 'unknown')`,
    );
    const add = `INSERT INTO workspace_task_census VALUES (COALESCE(NEW.status, 'unknown'), 1)
      ON CONFLICT(status) DO UPDATE SET count=count+1;`,
      subtract = "UPDATE workspace_task_census SET count=count-1 WHERE status=COALESCE(OLD.status, 'unknown');";
    runSql(
      db,
      `CREATE TRIGGER workspace_census_insert AFTER INSERT ON task_snapshot
      WHEN NEW.package_disposition='active' BEGIN ${add} END`,
    );
    runSql(
      db,
      `CREATE TRIGGER workspace_census_delete AFTER DELETE ON task_snapshot
      WHEN OLD.package_disposition='active' BEGIN ${subtract} END`,
    );
    runSql(
      db,
      `CREATE TRIGGER workspace_census_update_remove AFTER UPDATE OF status,snapshot_json ON task_snapshot
      WHEN OLD.package_disposition='active' BEGIN ${subtract} END`,
    );
    runSql(
      db,
      `CREATE TRIGGER workspace_census_update_add AFTER UPDATE OF status,snapshot_json ON task_snapshot
      WHEN NEW.package_disposition='active' BEGIN ${add} END`,
    );
  });
}
