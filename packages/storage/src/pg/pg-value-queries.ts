import type { PoolClient } from "pg";
import type {
  EntityProjectionRow,
  PinnedEntityProjectionRow,
  RuntimeSession,
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
  | "readDocumentMetadata"
  | "readDocument"
  | "readDocuments"
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
  const documents = async (client: PoolClient, prefix: string) => {
    const upper = prefixUpperBound(prefix),
      result = await client.query<{ value: string | null }>(
        `SELECT document_metadata AS value FROM ha_projection_values
         WHERE tenant_id=$1 AND project_id=$2 AND policy_epoch=$3 AND model='document'
           AND owner_id='' AND entity_id COLLATE "C" >= $5
           ${upper === null ? "" : 'AND entity_id COLLATE "C" < $6'}
           AND (cardinality($4::text[])=0 OR readers && $4::text[])
         ORDER BY entity_id COLLATE "C"`,
        [scope.tenantId, scope.projectId, scope.policyEpoch, readers, prefix, ...(upper === null ? [] : [upper])],
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
    listPinnedEntities: async () =>
      (await list<PinnedEntityProjectionRow>("pin")).toSorted((a, b) =>
        a.pinnedAt === b.pinnedAt ? compare(a.entityRef, b.entityRef) : compare(b.pinnedAt, a.pinnedAt),
      ),
    readRuntimeInstallation: (id) => get("runtime-installation", id),
    readRuntimeInstallations: () => list("runtime-installation"),
    readRuntimeSession: (id) => get("runtime-session", id),
    // Runtime sessions stay JSON text because documents may contain NUL, but the unsettled and
    // node-owner predicates are evaluated by PostgreSQL against the partial expression index.
    readRuntimeSessions: (query) => read((client) => listPgRuntimeSessions(client, scope, repoId, query)),
    readRuntimeSessionsForTask: async (taskId) =>
      (await list<RuntimeSession>("runtime-session")).filter((session) =>
        session.taskBindings.some((binding) => binding.taskId === taskId),
      ),
    readRuntimeSessionPage: (query) =>
      read(async (client) => {
        if (!Number.isInteger(query.limit) || query.limit < 1 || query.limit > 64)
          throw new Error("runtime session page limit must be between 1 and 64");
        const matched = (await listPgProjectionValues<RuntimeSession>(client, scope, "runtime-session")).filter(
            (session) =>
              (!query.taskId || session.taskBindings.some(({ taskId }) => taskId === query.taskId)) &&
              (query.afterRuntimeSessionId === undefined || session.runtimeSessionId > query.afterRuntimeSessionId),
          ),
          rows = matched.slice(0, query.limit),
          remainingCount = matched.length - rows.length;
        return {
          rows,
          remainingCount,
          nextRuntimeSessionId: remainingCount > 0 ? rows.at(-1)!.runtimeSessionId : null,
        };
      }),
    readSquadRun: (id) => get<SquadRunProjectionRow>("squad-run", id),
    readSquadRuns: () => list<SquadRunProjectionRow>("squad-run"),
    readLeaseIntervals: (taskId) =>
      read(async (client) =>
        [...(await listPgProjectionValues<LeaseInterval>(client, scope, "lease-interval", taskId))].sort(
          (a, b) => a.acquiredRevision - b.acquiredRevision,
        ),
      ),
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
    readDocuments: (prefix) =>
      read(async (client) => ({
        ...(await readCutInTransaction(client, scope, readers, repoId)),
        documents: await documents(client, prefix),
      })),
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
/** Exclusive UTF-8/C-collation boundary; wildcard characters remain literal path bytes. */
function prefixUpperBound(prefix: string): string | null {
  const points = Array.from(prefix, (character) => character.codePointAt(0)!);
  for (let index = points.length - 1; index >= 0; index--) {
    const point = points[index]!;
    if (point < 0x10ffff) {
      const next = point === 0xd7ff ? 0xe000 : point + 1;
      return (
        points
          .slice(0, index)
          .map((value) => String.fromCodePoint(value))
          .join("") + String.fromCodePoint(next)
      );
    }
  }
  return null;
}
function compare(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** Raw path ancestors preserve the port's literal prefix semantics, including repeated slashes. */
function documentPathAncestors(path: string): readonly string[] {
  const paths = [path];
  for (let index = path.indexOf("/"); index !== -1; index = path.indexOf("/", index + 1))
    paths.push(path.slice(0, index));
  return paths;
}
