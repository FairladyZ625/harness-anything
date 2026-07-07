import { SqlClient } from "@effect/sql";
import { Effect } from "effect";
import type { ProjectionMeta, TaskFieldExtensionProjection, TaskProjectionRow, DecisionProjectionRow } from "./types.ts";
import type { ProjectionGraphRows } from "./sqlite-projection-store.ts";
import {
  insertCoverageRow,
  insertDecisionRow,
  insertFactAnchor,
  insertRelationEdge,
  insertTaskRow,
  queryableTaskFieldExtensions,
  runSqlite
} from "./sqlite-projection-store.ts";

export function updateProjectionDatabase(
  projectionPath: string,
  change: {
    readonly deleteTaskIds: ReadonlyArray<string>;
    readonly upsertTaskRows: ReadonlyArray<TaskProjectionRow>;
    readonly deleteDecisionIds: ReadonlyArray<string>;
    readonly upsertDecisionRows: ReadonlyArray<DecisionProjectionRow>;
    readonly meta: ProjectionMeta;
    readonly graphRows: ProjectionGraphRows;
    readonly taskFieldExtensions?: ReadonlyArray<TaskFieldExtensionProjection>;
  }
): void {
  runSqlite(projectionPath, Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const projectedTaskFieldExtensions = queryableTaskFieldExtensions(change.taskFieldExtensions ?? []);
    yield* sql`BEGIN IMMEDIATE`;
    try {
      for (const taskId of uniqueProjectionIds(change.deleteTaskIds)) {
        yield* sql`DELETE FROM task_projection WHERE task_id = ${taskId}`;
      }
      for (const row of change.upsertTaskRows) {
        yield* insertTaskRow(sql, row, projectedTaskFieldExtensions);
      }
      for (const decisionId of uniqueProjectionIds(change.deleteDecisionIds)) {
        yield* sql`DELETE FROM decision_projection WHERE decision_id = ${decisionId}`;
      }
      for (const row of change.upsertDecisionRows) {
        yield* insertDecisionRow(sql, row);
      }
      yield* sql`DELETE FROM relation_edges`;
      yield* sql`DELETE FROM relation_coverage`;
      yield* sql`DELETE FROM task_fact_anchors`;
      for (const edge of change.graphRows.relationEdges) yield* insertRelationEdge(sql, edge);
      for (const row of change.graphRows.coverageRows) yield* insertCoverageRow(sql, row);
      for (const row of change.graphRows.factAnchors) yield* insertFactAnchor(sql, row);
      yield* upsertMeta(sql, "sourceHash", change.meta.sourceHash);
      yield* upsertMeta(sql, "rowsHash", change.meta.rowsHash);
      yield* upsertMeta(sql, "decisionRowsHash", change.meta.decisionRowsHash ?? "");
      yield* sql`COMMIT`;
    } catch (error) {
      yield* sql`ROLLBACK`;
      throw error;
    }
  }));
}

function upsertMeta(sql: SqlClient.SqlClient, key: string, value: string): Effect.Effect<unknown, unknown> {
  return sql`INSERT OR REPLACE INTO projection_meta (key, value) VALUES (${key}, ${value})`;
}

function uniqueProjectionIds(values: ReadonlyArray<string>): ReadonlyArray<string> {
  return [...new Set(values)];
}
