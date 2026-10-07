import type { DatabaseSync } from "node:sqlite";
import type { DocumentState } from "../domain/doc-sync-types.ts";
import { getEntityProjectionRow } from "./rebuildable-task-projection-entities.ts";
import { presentSnapshot } from "./rebuildable-task-projection-reads.ts";
import { readSnapshots } from "./rebuildable-task-projection-runtime.ts";
import { emptyTaskLifecycleSnapshot } from "../domain/task-lifecycle.contract.ts";
import {
  readTaskChildCounts,
  readTaskIndexRows,
  readTaskPresentationStatus,
  readTaskProgressRows,
  readTaskRelationPage,
} from "./task-query-projection.ts";
import { readDecisionRows } from "./decision-projection-reads.ts";
import type { TaskProjectionQueries } from "./task-projection-port.ts";

/**
 * The read face an edge replica serves task show from: the same kernel query bodies the center's
 * projection answers with, run against the materialized edge tables, including the document table
 * the materializer rebuilds from the view's content entries.
 */
export type EdgeReplicaQueries = TaskProjectionQueries;

export interface EdgeReplicaQuerySource {
  readonly db: DatabaseSync;
  /** The read model's cut: status plus the revision its rows describe. */
  readonly cut: {
    readonly status: "ready" | "pending";
    readonly watermark: number;
    readonly sourceRevision: number;
  };
  readonly now?: () => string;
}

export function makeEdgeReplicaQueries(source: EdgeReplicaQuerySource): EdgeReplicaQueries {
  const { db, cut } = source,
    now = source.now ?? (() => new Date().toISOString());
  const implemented = {
    read: (taskId, presentationStatus) => {
      const stored = readSnapshots(db, [taskId], now()).get(taskId) ?? emptyTaskLifecycleSnapshot(),
        snapshot = presentationStatus ? presentSnapshot(stored, readTaskPresentationStatus(db, taskId)) : stored;
      return {
        status: cut.status,
        snapshot,
        packagePath:
          (
            db.prepare("SELECT package_path FROM task_package WHERE task_id = ?").get(taskId) as
              | { readonly package_path: string }
              | undefined
          )?.package_path ?? null,
        watermark: cut.watermark,
        sourceRevision: cut.sourceRevision,
        warnings: [],
        catchUp: { maxItems: 4096, reducedItems: 0, sqliteTransactions: 0 },
      };
    },
    readProgress: (taskId) => ({
      status: cut.status,
      rows: readTaskProgressRows(db, taskId),
      watermark: cut.watermark,
      sourceRevision: cut.sourceRevision,
    }),
    readTaskIndex: (query = {}) => ({
      schema: "task-index-projection/v1" as const,
      status: cut.status,
      ...readTaskIndexRows(db, query),
      watermark: cut.watermark,
      sourceRevision: cut.sourceRevision,
      warnings: [],
    }),
    readTaskChildCounts: (parentTaskIds) => readTaskChildCounts(db, parentTaskIds),
    getEntity: (entityKind, entityId) => getEntityProjectionRow(db, entityKind, entityId),
    readPresetSnapshot: (digest) => {
      const row = db.prepare("SELECT value_json FROM preset_snapshot WHERE digest = ?").get(digest) as
        | { readonly value_json: string }
        | undefined;
      return {
        status: cut.status,
        snapshot: row === undefined ? null : (JSON.parse(row.value_json) as unknown),
        watermark: cut.watermark,
        sourceRevision: cut.sourceRevision,
      };
    },
    readRelationQuery: (query = {}) => {
      const page = readTaskRelationPage(db, query);
      return {
        status: cut.status,
        rows: page.rows,
        ...(page.page ? { page: page.page } : {}),
        watermark: cut.watermark,
        sourceRevision: cut.sourceRevision,
      };
    },
    readDecisions: (decisionIds) => ({
      status: cut.status,
      decisions: readDecisionRows(db, decisionIds),
      watermark: cut.watermark,
      sourceRevision: cut.sourceRevision,
    }),
    readDocument: (documentPath) => {
      const row = db.prepare("SELECT value_json FROM document WHERE path = ?").get(documentPath) as
        | { readonly value_json: string }
        | undefined;
      return {
        status: cut.status,
        document: row === undefined ? null : (JSON.parse(row.value_json) as DocumentState),
        watermark: cut.watermark,
        sourceRevision: cut.sourceRevision,
      };
    },
  } satisfies Pick<
    TaskProjectionQueries,
    | "read"
    | "readProgress"
    | "readTaskIndex"
    | "readTaskChildCounts"
    | "getEntity"
    | "readPresetSnapshot"
    | "readRelationQuery"
    | "readDecisions"
    | "readDocument"
  >;
  const unavailable = (name: string): never => {
    throw Object.assign(new Error(`Replica read model does not materialize ${name}.`), {
      code: "replica_unavailable",
    });
  };
  return new Proxy(implemented as unknown as TaskProjectionQueries, {
    get(target, property, receiver) {
      if (typeof property !== "string") return Reflect.get(target, property, receiver);
      return property in target ? Reflect.get(target, property, receiver) : () => unavailable(property);
    },
  });
}
