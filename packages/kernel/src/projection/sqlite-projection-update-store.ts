import { SqlClient } from "@effect/sql";
import { Effect } from "effect";
import { isDeepStrictEqual } from "node:util";
import type { ProjectionMeta, TaskFieldExtensionProjection, TaskProjectionRow, DecisionProjectionRow } from "./types.ts";
import type { ProjectionGraphRows } from "./sqlite-projection-store.ts";
import { deleteDeclaredProjectionRows, upsertDeclaredProjectionRows } from "./entity-declaration-projection.ts";
import { applyDeclaredSourceManifestDelta, type DeclaredProjectionDelta } from "./sqlite-declared-source-manifest.ts";
import {
  applyProjectionSourceCacheChange,
  type ProjectionSourceCacheChange
} from "./sqlite-projection-source-cache.ts";
import {
  applyAttributionProjectionDelta,
  materializeEntityAttributionSubjects,
  materializeEntityAttributionTargets,
} from "./sqlite-attribution-projection.ts";
import type { AttributionProjectionDelta } from "./sqlite-attribution-projection.ts";
import {
  insertCoverageRows,
  insertDecisionRow,
  insertFactAnchors,
  insertRelationProjectionWarning,
  insertRelationEdges,
  insertTaskFactRows,
  insertTaskRow,
  queryableTaskFieldExtensions,
  runSqlite
} from "./sqlite-projection-store.ts";
import { hashAttributionProjectionState } from "./sqlite-attribution-state-hash.ts";

export type ProjectionDatabasePhase =
  | "start"
  | "task-rows-done"
  | "decision-rows-done"
  | "graph-rows-done"
  | "declared-rows-done"
  | "source-cache-done"
  | "attribution-done"
  | "meta-done"
  | "commit-start"
  | "commit-done"
  | "done";

export function updateProjectionDatabase(
  projectionPath: string,
  change: {
    readonly deleteTaskIds: ReadonlyArray<string>;
    readonly upsertTaskRows: ReadonlyArray<TaskProjectionRow>;
    readonly deleteDecisionIds: ReadonlyArray<string>;
    readonly upsertDecisionRows: ReadonlyArray<DecisionProjectionRow>;
    readonly meta: ProjectionMeta;
    readonly graphRows?: ProjectionGraphRows;
    readonly previousGraphRows?: ProjectionGraphRows;
    readonly preserveGraphFactRows?: boolean;
    readonly declaredDelta: DeclaredProjectionDelta;
    readonly attributionDelta?: AttributionProjectionDelta;
    readonly sourceCache?: ProjectionSourceCacheChange;
    readonly taskFieldExtensions?: ReadonlyArray<TaskFieldExtensionProjection>;
    readonly onPhase?: (phase: ProjectionDatabasePhase) => void;
  }
): void {
  const report = (phase: ProjectionDatabasePhase): void => {
    try {
      change.onPhase?.(phase);
    } catch {
      // Projection telemetry is non-authoritative.
    }
  };
  const graphDelta = change.graphRows && change.previousGraphRows
    ? projectionGraphDelta(change.previousGraphRows, change.graphRows, change.preserveGraphFactRows === true)
    : undefined;
  report("start");
  runSqlite(projectionPath, Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const projectedTaskFieldExtensions = queryableTaskFieldExtensions(change.taskFieldExtensions ?? []);
    yield* sql`BEGIN IMMEDIATE`;
    try {
      const reuseAttributionRowsHash = yield* canReuseAttributionRowsHash(sql, change);
      const upsertTaskIds = new Set(change.upsertTaskRows.map((row) => row.taskId));
      for (const taskId of uniqueProjectionIds(change.deleteTaskIds)) {
        if (upsertTaskIds.has(taskId)) continue;
        yield* sql`DELETE FROM task_projection WHERE task_id = ${taskId}`;
      }
      for (const row of change.upsertTaskRows) {
        yield* insertTaskRow(sql, row, projectedTaskFieldExtensions);
      }
      report("task-rows-done");
      const upsertDecisionIds = new Set(change.upsertDecisionRows.map((row) => row.decisionId));
      for (const decisionId of uniqueProjectionIds(change.deleteDecisionIds)) {
        if (upsertDecisionIds.has(decisionId)) continue;
        yield* sql`DELETE FROM decision_projection WHERE decision_id = ${decisionId}`;
      }
      for (const row of change.upsertDecisionRows) {
        yield* insertDecisionRow(sql, row);
      }
      report("decision-rows-done");
      if (change.graphRows) {
        if (graphDelta) {
          for (const relationId of graphDelta.edges.deleteKeys) yield* sql`DELETE FROM relation_edges WHERE relation_id = ${relationId}`;
          for (const claimRef of graphDelta.coverage.deleteKeys) yield* sql`DELETE FROM relation_coverage WHERE claim_ref = ${claimRef}`;
          yield* insertRelationEdges(sql, graphDelta.edges.upsertRows);
          yield* insertCoverageRows(sql, graphDelta.coverage.upsertRows);
          if (!change.preserveGraphFactRows) {
            for (const factRef of graphDelta.factAnchors.deleteKeys) yield* sql`DELETE FROM task_fact_anchors WHERE fact_ref = ${factRef}`;
            for (const factRef of graphDelta.factRows.deleteKeys) yield* sql`DELETE FROM task_fact_projection WHERE fact_ref = ${factRef}`;
            for (const warningIndex of graphDelta.warnings.deleteKeys) yield* sql`DELETE FROM relation_projection_warnings WHERE warning_index = ${warningIndex}`;
            yield* insertFactAnchors(sql, graphDelta.factAnchors.upsertRows);
            yield* insertTaskFactRows(sql, graphDelta.factRows.upsertRows);
            for (const { index, row } of graphDelta.warnings.upsertRows) yield* insertRelationProjectionWarning(sql, index, row);
          }
        } else {
          yield* sql`DELETE FROM relation_edges`;
          yield* sql`DELETE FROM relation_coverage`;
          yield* insertRelationEdges(sql, change.graphRows.relationEdges);
          yield* insertCoverageRows(sql, change.graphRows.coverageRows);
          if (!change.preserveGraphFactRows) {
            yield* sql`DELETE FROM task_fact_anchors`;
            yield* sql`DELETE FROM task_fact_projection`;
            yield* sql`DELETE FROM relation_projection_warnings`;
            yield* insertFactAnchors(sql, change.graphRows.factAnchors);
            yield* insertTaskFactRows(sql, change.graphRows.factRows);
            for (const [index, row] of change.graphRows.warnings.entries()) yield* insertRelationProjectionWarning(sql, index, row);
          }
        }
      }
      report("graph-rows-done");
      for (const table of change.declaredDelta.tables) {
        const primaryKey = table.declaration.projection.columns.find((column) => column.primaryKey)!;
        const upsertIds = new Set(table.upsertRows.map((row) => String(row[primaryKey.name])));
        yield* deleteDeclaredProjectionRows(
          sql,
          table.declaration,
          table.deletePrimaryKeys.filter((id) => !upsertIds.has(id))
        );
        yield* upsertDeclaredProjectionRows(sql, table.declaration, table.upsertRows);
      }
      report("declared-rows-done");
      yield* applyDeclaredSourceManifestDelta(sql, change.declaredDelta.manifest);
      if (change.sourceCache) yield* applyProjectionSourceCacheChange(sql, change.sourceCache);
      report("source-cache-done");
      if (change.attributionDelta) {
        const affectedSubjects = yield* applyAttributionProjectionDelta(sql, change.attributionDelta);
        yield* materializeEntityAttributionSubjects(sql, affectedSubjects);
        yield* materializeEntityAttributionTargets(sql, changedAttributionTargets(change));
      } else if (!reuseAttributionRowsHash) {
        yield* materializeEntityAttributionTargets(sql, changedAttributionTargets(change));
      }
      report("attribution-done");
      yield* upsertMeta(sql, "sourceHash", change.meta.sourceHash);
      yield* upsertMeta(sql, "rowsHash", change.meta.rowsHash);
      yield* upsertMeta(sql, "decisionRowsHash", change.meta.decisionRowsHash ?? "");
      yield* upsertMeta(sql, "declaredRowsHash", change.meta.declaredRowsHash ?? "");
      yield* upsertMeta(sql, "declaredManifestHash", change.meta.declaredManifestHash ?? "");
      const attributionRowsHash = reuseAttributionRowsHash && change.meta.attributionRowsHash
        ? change.meta.attributionRowsHash
        : yield* hashAttributionProjectionState(sql);
      yield* upsertMeta(sql, "attributionRowsHash", attributionRowsHash);
      yield* upsertMeta(sql, "attributionSourceHash", change.meta.attributionSourceHash ?? "");
      yield* upsertMeta(sql, "taskSourceHash", change.meta.taskSourceHash ?? "");
      if (change.sourceCache) yield* upsertMeta(sql, "sourceCacheHash", change.sourceCache.current.hash);
      yield* upsertMeta(sql, "legacyPersonIdsHash", change.meta.legacyPersonIdsHash ?? "");
      report("meta-done");
      report("commit-start");
      yield* sql`COMMIT`;
      report("commit-done");
    } catch (error) {
      yield* sql`ROLLBACK`;
      throw error;
    }
  }));
  report("done");
}

function projectionGraphDelta(
  previous: ProjectionGraphRows,
  current: ProjectionGraphRows,
  preserveFactRows: boolean
) {
  return {
    edges: changedRows(previous.relationEdges, current.relationEdges, (row) => row.relationId),
    coverage: changedRows(previous.coverageRows, current.coverageRows, (row) => row.claimRef),
    factAnchors: preserveFactRows
      ? { deleteKeys: [] as string[], upsertRows: [] as ProjectionGraphRows["factAnchors"] }
      : changedRows(previous.factAnchors, current.factAnchors, (row) => row.factRef),
    factRows: preserveFactRows
      ? { deleteKeys: [] as string[], upsertRows: [] as ProjectionGraphRows["factRows"] }
      : changedRows(previous.factRows, current.factRows, (row) => row.ref),
    warnings: preserveFactRows
      ? { deleteKeys: [] as number[], upsertRows: [] as Array<{ readonly index: number; readonly row: ProjectionGraphRows["warnings"][number] }> }
      : changedRows(
        previous.warnings.map((row, index) => ({ index, row })),
        current.warnings.map((row, index) => ({ index, row })),
        (entry) => entry.index
      )
  };
}

function changedRows<Key, Row>(
  previous: ReadonlyArray<Row>,
  current: ReadonlyArray<Row>,
  keyOf: (row: Row) => Key
): { readonly deleteKeys: ReadonlyArray<Key>; readonly upsertRows: ReadonlyArray<Row> } {
  const previousByKey = new Map(previous.map((row) => [keyOf(row), row]));
  const currentByKey = new Map(current.map((row) => [keyOf(row), row]));
  return {
    deleteKeys: [...previousByKey.keys()].filter((key) => !currentByKey.has(key)),
    upsertRows: current.filter((row) => {
      const previousRow = previousByKey.get(keyOf(row));
      return previousRow === undefined || !isDeepStrictEqual(previousRow, row);
    })
  };
}

function canReuseAttributionRowsHash(
  sql: SqlClient.SqlClient,
  change: {
    readonly deleteTaskIds: ReadonlyArray<string>;
    readonly upsertTaskRows: ReadonlyArray<TaskProjectionRow>;
    readonly deleteDecisionIds: ReadonlyArray<string>;
    readonly upsertDecisionRows: ReadonlyArray<DecisionProjectionRow>;
    readonly declaredDelta: DeclaredProjectionDelta;
    readonly attributionDelta?: AttributionProjectionDelta;
  }
): Effect.Effect<boolean, unknown> {
  return Effect.gen(function* () {
    if (change.attributionDelta) return false;
    const finalTaskIds = new Set(change.upsertTaskRows.map((row) => row.taskId));
    if (change.deleteTaskIds.some((taskId) => !finalTaskIds.has(taskId))) return false;
    const finalDecisionIds = new Set(change.upsertDecisionRows.map((row) => row.decisionId));
    if (change.deleteDecisionIds.some((decisionId) => !finalDecisionIds.has(decisionId))) return false;
    for (const table of change.declaredDelta.tables) {
      const primaryKey = table.declaration.projection.columns.find((column) => column.primaryKey)!;
      const finalIds = new Set(table.upsertRows.map((row) => String(row[primaryKey.name])));
      if (table.deletePrimaryKeys.some((id) => !finalIds.has(id))) return false;
    }
    for (const target of changedAttributionTargets(change)) {
      const idColumn = attributionEntityIdColumns.get(target.table);
      if (!idColumn) throw new Error(`unknown attributed projection table: ${target.table}`);
      const records = yield* sql.unsafe(`SELECT 1 FROM ${target.table} WHERE ${idColumn} = ? LIMIT 1`, [target.id]);
      if (records.length === 0) return false;
    }
    return true;
  });
}

function changedAttributionTargets(change: {
  readonly upsertTaskRows: ReadonlyArray<TaskProjectionRow>;
  readonly upsertDecisionRows: ReadonlyArray<DecisionProjectionRow>;
  readonly declaredDelta: DeclaredProjectionDelta;
}): ReadonlyArray<{ readonly table: string; readonly id: string }> {
  return [
    ...change.upsertTaskRows.map((row) => ({ table: "task_projection", id: row.taskId })),
    ...change.upsertDecisionRows.map((row) => ({ table: "decision_projection", id: row.decisionId })),
    ...change.declaredDelta.tables.flatMap((table) => {
      const primaryKey = table.declaration.projection.columns.find((column) => column.primaryKey)!;
      return table.upsertRows.map((row) => ({
        table: table.declaration.projection.table,
        id: String(row[primaryKey.name])
      }));
    })
  ];
}

function upsertMeta(sql: SqlClient.SqlClient, key: string, value: string): Effect.Effect<unknown, unknown> {
  return sql`INSERT OR REPLACE INTO projection_meta (key, value) VALUES (${key}, ${value})`;
}

function uniqueProjectionIds(values: ReadonlyArray<string>): ReadonlyArray<string> {
  return [...new Set(values)];
}

const attributionEntityIdColumns = new Map([
  ["task_projection", "task_id"],
  ["decision_projection", "decision_id"],
  ["session_projection", "session_id"],
  ["execution_projection", "execution_id"],
  ["consent_projection", "consent_id"],
  ["review_projection", "review_id"]
]);
