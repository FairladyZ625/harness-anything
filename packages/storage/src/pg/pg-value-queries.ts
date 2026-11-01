import type { PoolClient } from "pg";
import type {
  EntityProjectionRow,
  PinnedEntityProjectionRow,
  RuntimeSession,
  LeaseInterval,
  SquadRunProjectionRow,
} from "@harness-anything/kernel";
import type { DocumentState } from "@harness-anything/kernel/internal/domain/doc-sync.contract.ts";
import { withPostgresTransaction } from "../postgres/transaction.ts";
import { readCutInTransaction, readEventRowsInTransaction } from "./pg-event-queries.ts";
import { getPgProjectionValue, listPgProjectionValues } from "./pg-projection-values.ts";
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
  const documents = async (client: PoolClient, prefix: string) =>
    (await listPgProjectionValues<DocumentState>(client, scope, "document"))
      .filter(({ path }) => path.startsWith(prefix))
      .map(({ path, blobSha256, size, mediaType, policyId }) => ({
        path,
        blobSha256,
        size,
        mediaType,
        policyId: policyId ?? null,
      }));
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
        const row = await client.query<{ value: EntityProjectionRow }>(
          `SELECT value FROM ha_projection_values WHERE tenant_id=$1 AND project_id=$2 AND policy_epoch=$3 AND model=$4 AND entity_id=$5
         AND (cardinality($6::text[])=0 OR readers && $6::text[]) ORDER BY workspace_revision DESC LIMIT 1`,
          [scope.tenantId, scope.projectId, scope.policyEpoch, `entity:${kind}`, id, readers],
        );
        return row.rows[0]?.value ?? null;
      }),
    listPinnedEntities: async () =>
      (await list<PinnedEntityProjectionRow>("pin")).toSorted((a, b) =>
        a.pinnedAt === b.pinnedAt ? compare(a.entityRef, b.entityRef) : compare(b.pinnedAt, a.pinnedAt),
      ),
    readRuntimeInstallation: (id) => get("runtime-installation", id),
    readRuntimeInstallations: () => list("runtime-installation"),
    readRuntimeSession: (id) => get("runtime-session", id),
    readRuntimeSessions: () => list("runtime-session"),
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
          headEvent: head[0] ? JSON.parse(head[0].event_json) : null,
          events: rows.map(({ event_json }) => JSON.parse(event_json)),
        };
      }),
    taskIdForDocumentPath: (path) =>
      read(async (client) => {
        const result = await client.query<{ task_id: string }>(
          `SELECT task_id FROM ha_task_snapshots WHERE tenant_id=$1 AND project_id=$2 AND policy_epoch=$3
         AND (cardinality($4::text[])=0 OR readers && $4::text[])
         AND ($5=package_path OR starts_with($5,package_path || '/')) ORDER BY length(package_path) DESC LIMIT 1`,
          [scope.tenantId, scope.projectId, scope.policyEpoch, readers, path],
        );
        return result.rows[0]?.task_id ?? null;
      }),
  };
}
function compare(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}
