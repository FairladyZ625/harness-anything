import { prefixUpperBound } from "../projection/document-read-range.ts";
import { documentPathAncestors } from "../projection/document-path-ancestors.ts";
import { entityValueFilterEntries } from "../projection/entity-value-filter.ts";
import { checkedPageLimit } from "./pg-query-page.ts";
import { readPgTaskSessions, readPgSessionPage } from "./pg-runtime-session-queries.ts";
import { assertPgReadIndexReady } from "./pg-read-index-migration.ts";
import { readPgArtifactTimeline } from "./pg-artifact-timeline.ts";
import type { PoolClient } from "pg";
import type {
  EntityProjectionRow,
  PinnedEntityProjectionRow,
  LeaseInterval,
  SquadRunProjectionRow,
  CanonicalEventV1,
} from "@harness-anything/kernel";
import type { DocumentState } from "@harness-anything/kernel/internal/domain/doc-sync.contract.ts";
import { withPostgresTransaction } from "../postgres/transaction.ts";
import { eventIndexEvent, readCutInTransaction, readEventRowsInTransaction } from "./pg-event-queries.ts";
import { getPgProjectionValue, listPgProjectionValues, listPgRuntimeSessions } from "./pg-projection-values.ts";
import type { PgTaskProjectionSourceOptions } from "./pg-task-source.ts";
import type { AsyncQueries } from "./pg-runtime-dispatch-queries.ts";

export type PgValueQueries = AsyncQueries<
  | "listEntities"
  | "countEntities"
  | "getEntity"
  | "listPinnedEntities"
  | "readRuntimeInstallation"
  | "readRuntimeInstallations"
  | "readRuntimeSession"
  | "readRuntimeSessions"
  | "readRuntimeSessionsForTask"
  | "readRuntimeSessionPage"
  | "readSquadRun"
  | "readSquadRuns"
  | "readLeaseIntervals"
  | "readLatestLeaseIntervalForExecution"
  | "readLatestLeaseInterval"
  | "readDocumentMetadata"
  | "readDocument"
  | "readDocuments"
  | "readArtifactTimelinePage"
  | "readReplicaBasis"
  | "taskIdForDocumentPath"
  | "readArtifactEntityState"
  | "readPresetSnapshot"
>;
export function pgValueQueries(options: PgTaskProjectionSourceOptions): PgValueQueries {
  const { scope, repoId } = options,
    readers = [...(scope.readers ?? [])];
  const read = <Result>(operation: (client: PoolClient) => Promise<Result>) =>
    withPostgresTransaction(options.pool, operation, scope, { isolationLevel: "repeatable read" });
  const get = <Result>(model: string, id: string) =>
    read((client) => getPgProjectionValue<Result>(client, scope, model, id));
  const list = <Result>(model: string) => read((client) => listPgProjectionValues<Result>(client, scope, model));
  const documents = async (
    client: PoolClient,
    prefix: string,
    page?: { readonly limit: number; readonly afterPath?: string },
  ) => {
    const upper = prefixUpperBound(prefix),
      values: unknown[] = [
        scope.tenantId,
        scope.projectId,
        scope.policyEpoch,
        readers,
        prefix,
        ...(upper === null ? [] : [upper]),
      ],
      after = page?.afterPath,
      afterPredicate = after === undefined ? "" : `AND entity_id COLLATE "C" > $${values.push(after)}`,
      limitClause = page === undefined ? "" : `LIMIT $${values.push(checkedPageLimit(page.limit, 500) + 1)}`,
      result = await client.query<{ value: string | null }>(
        `SELECT document_metadata AS value FROM ha_projection_values
         WHERE tenant_id=$1 AND project_id=$2 AND policy_epoch=$3 AND model='document'
           AND owner_id='' AND entity_id COLLATE "C" >= $5
           ${upper === null ? "" : 'AND entity_id COLLATE "C" < $6'}
           AND (cardinality($4::text[])=0 OR readers && $4::text[])
         ${afterPredicate} ORDER BY entity_id COLLATE "C" ${limitClause}`,
        values,
      );
    return result.rows.map(({ value }) => {
      if (value === null)
        throw Object.assign(new Error("Document metadata backfill is pending; retry after migration."), {
          code: "projection_pending",
        });
      const { path, blobSha256, size, mediaType, policyId } = JSON.parse(value) as Omit<DocumentState, "body">;
      return { path, blobSha256, size, mediaType, policyId: policyId ?? null };
    });
  };
  const ready = async (client: PoolClient) => {
    const cut = await readCutInTransaction(client, scope, readers, repoId);
    if (cut.watermark !== cut.sourceRevision)
      throw Object.assign(
        new Error(`Entity projection is catching up (${cut.watermark}/${cut.sourceRevision}); retry the read.`),
        { code: "projection_pending" },
      );
  };
  return {
    listEntities: (kind) =>
      read(async (client) => {
        await ready(client);
        return listPgProjectionValues<EntityProjectionRow>(client, scope, `entity:${kind}`);
      }),
    countEntities: (kind, valueEquals) =>
      read(async (client) => {
        await ready(client);
        // The PG projection stores the whole EntityProjectionRow, so the caller's entity fields
        // live under its `value` member; SQLite stores the entity value at the row root.
        const entries = entityValueFilterEntries(valueEquals),
          filters = entries.map(([field], index) => `ha_read_index_json(value)->'value'->>'${field}' = $${6 + index}`),
          row = await client.query<{ count: string }>(
            `SELECT count(*)::text AS count FROM ha_projection_values WHERE tenant_id=$1 AND project_id=$2 AND policy_epoch=$3 AND model=$4
             AND (cardinality($5::text[])=0 OR readers && $5::text[])${filters.length === 0 ? "" : ` AND ${filters.join(" AND ")}`}`,
            [
              scope.tenantId,
              scope.projectId,
              scope.policyEpoch,
              `entity:${kind}`,
              readers,
              ...entries.map(([, value]) => String(value)),
            ],
          );
        return Number(row.rows[0]?.count ?? 0);
      }),
    getEntity: (kind, id) =>
      read(async (client) => {
        await ready(client);
        const row = await client.query<{ value: string }>(
          `SELECT value FROM ha_projection_values WHERE tenant_id=$1 AND project_id=$2 AND policy_epoch=$3 AND model=$4 AND entity_id=$5
         AND (cardinality($6::text[])=0 OR readers && $6::text[]) ORDER BY workspace_revision DESC LIMIT 1`,
          [scope.tenantId, scope.projectId, scope.policyEpoch, `entity:${kind}`, id, readers],
        );
        return row.rows[0] ? (JSON.parse(row.rows[0].value) as EntityProjectionRow) : null;
      }),
    listPinnedEntities: () =>
      read(async (client) => {
        await assertPgReadIndexReady(client, scope, "pin");
        const result = await client.query<{ value: string }>(
          `SELECT value FROM ha_projection_values WHERE tenant_id=$1 AND project_id=$2 AND policy_epoch=$3
          AND model='pin' AND (cardinality($4::text[])=0 OR readers && $4::text[])
          ORDER BY order_at DESC,entity_id`,
          [scope.tenantId, scope.projectId, scope.policyEpoch, readers],
        );
        return result.rows.map(({ value }) => JSON.parse(value) as PinnedEntityProjectionRow);
      }),
    readRuntimeInstallation: (id) => get("runtime-installation", id),
    readRuntimeInstallations: () => list("runtime-installation"),
    readRuntimeSession: (id) => get("runtime-session", id),
    readRuntimeSessions: (query) => read((client) => listPgRuntimeSessions(client, scope, repoId, query)),
    readRuntimeSessionsForTask: (taskId) =>
      read(async (client) => (await readPgTaskSessions(client, scope, [taskId])).get(taskId) ?? []),
    readRuntimeSessionPage: (query) => read((client) => readPgSessionPage(client, scope, query)),
    readSquadRun: (id) => get<SquadRunProjectionRow>("squad-run", id),
    readSquadRuns: () => list<SquadRunProjectionRow>("squad-run"),
    readLeaseIntervals: (taskId) =>
      read(async (client) => {
        await assertPgReadIndexReady(client, scope, "lease-interval");
        const result = await client.query<{ value: string }>(
          `SELECT value FROM ha_projection_values WHERE tenant_id=$1 AND project_id=$2 AND policy_epoch=$3
          AND model='lease-interval' AND owner_id=$5 AND (cardinality($4::text[])=0 OR readers && $4::text[])
          ORDER BY order_revision`,
          [scope.tenantId, scope.projectId, scope.policyEpoch, readers, taskId],
        );
        return result.rows.map(({ value }) => JSON.parse(value) as LeaseInterval);
      }),
    readLatestLeaseIntervalForExecution: (taskId, executionId) =>
      read(async (client) => {
        await assertPgReadIndexReady(client, scope, "lease-interval");
        const result = await client.query<{ value: string }>(
          `SELECT value FROM ha_projection_values WHERE tenant_id=$1 AND project_id=$2 AND policy_epoch=$3
          AND model='lease-interval' AND owner_id=$5 AND execution_id=$6
          AND (cardinality($4::text[])=0 OR readers && $4::text[])
          ORDER BY order_revision DESC LIMIT 1`,
          [scope.tenantId, scope.projectId, scope.policyEpoch, readers, taskId, executionId],
        );
        return result.rows[0] ? (JSON.parse(result.rows[0].value) as LeaseInterval) : null;
      }),
    readLatestLeaseInterval: (taskId) =>
      read(async (client) => {
        await assertPgReadIndexReady(client, scope, "lease-interval");
        // ha_projection_interval_order leads with the task scope and order_revision, so the
        // backward scan plus LIMIT 1 visits one row instead of materializing the lease history.
        const result = await client.query<{ value: string }>(
          `SELECT value FROM ha_projection_values WHERE tenant_id=$1 AND project_id=$2 AND policy_epoch=$3
          AND model='lease-interval' AND owner_id=$5 AND (cardinality($4::text[])=0 OR readers && $4::text[])
          ORDER BY order_revision DESC LIMIT 1`,
          [scope.tenantId, scope.projectId, scope.policyEpoch, readers, taskId],
        );
        return result.rows[0] ? (JSON.parse(result.rows[0].value) as LeaseInterval) : null;
      }),
    readArtifactEntityState: (kind, id) => get(`artifact:${kind}`, id),
    readPresetSnapshot: (id) =>
      read(async (client) => ({
        ...(await readCutInTransaction(client, scope, readers, repoId)),
        snapshot: await getPgProjectionValue(client, scope, "preset", id),
      })),
    readDocumentMetadata: (path) =>
      read(async (client) => {
        const cut = await readCutInTransaction(client, scope, readers, repoId),
          row = await client.query<{ entity_id: string; workspace_revision: string }>(
            `SELECT entity_id, workspace_revision FROM ha_projection_values WHERE tenant_id=$1 AND project_id=$2 AND policy_epoch=$3 AND model='document' AND entity_id=$4 AND owner_id=''
           AND (cardinality($5::text[])=0 OR readers && $5::text[])`,
            [scope.tenantId, scope.projectId, scope.policyEpoch, path, readers],
          );
        return {
          ...cut,
          document: row.rows[0]
            ? { path: row.rows[0].entity_id, workspaceRevision: Number(row.rows[0].workspace_revision) }
            : null,
        };
      }),
    readDocument: (path) =>
      read(async (client) => ({
        ...(await readCutInTransaction(client, scope, readers, repoId)),
        document: await getPgProjectionValue<DocumentState>(client, scope, "document", path),
      })),
    readDocuments: (prefix, page) =>
      read(async (client) => {
        const cut = await readCutInTransaction(client, scope, readers, repoId),
          rows = await documents(client, prefix, page),
          selected = page === undefined ? rows : rows.slice(0, page.limit);
        return {
          ...cut,
          documents: selected,
          ...(page === undefined
            ? {}
            : { page: { nextPath: rows.length > page.limit ? selected.at(-1)!.path : null } }),
        };
      }),
    readArtifactTimelinePage: (query) =>
      read(async (client) => {
        const cut = await readCutInTransaction(client, scope, readers, repoId);
        return { ...cut, ...(await readPgArtifactTimeline(client, scope, query)) };
      }),
    readReplicaBasis: (after) =>
      read(async (client) => {
        if (after !== null && (!Number.isSafeInteger(after) || after < 0))
          throw new Error("replica basis revision must be a non-negative integer or null");
        const cut = await readCutInTransaction(client, scope, readers, repoId),
          head = await readEventRowsInTransaction(client, scope, readers, repoId, "revision=$6", [cut.watermark]),
          rows =
            after === null
              ? []
              : await readEventRowsInTransaction(client, scope, readers, repoId, "revision > $6", [after], "ASC", 64);
        return {
          watermark: cut.watermark,
          sourceRevision: cut.sourceRevision,
          documents: await documents(client, ""),
          headEvent: head[0] ? eventIndexEvent(JSON.parse(head[0].event_json) as CanonicalEventV1) : null,
          events: rows.map(({ event_json }) => eventIndexEvent(JSON.parse(event_json) as CanonicalEventV1)),
        };
      }),
    taskIdForDocumentPath: (path) =>
      read(async (client) => {
        const result = await client.query<{ task_id: string }>(
          `SELECT task_id FROM ha_task_snapshots WHERE tenant_id=$1 AND project_id=$2 AND policy_epoch=$3
         AND (cardinality($4::text[])=0 OR readers && $4::text[])
         AND package_path=ANY($5::text[]) ORDER BY length(package_path) DESC LIMIT 1`,
          [scope.tenantId, scope.projectId, scope.policyEpoch, readers, documentPathAncestors(path)],
        );
        return result.rows[0]?.task_id ?? null;
      }),
  };
}
