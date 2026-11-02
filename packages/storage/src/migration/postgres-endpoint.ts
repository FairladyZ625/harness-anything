import { auditPgProjectionRows } from "./postgres-projection-audit.ts";
import { POSTGRES_STORAGE_MIGRATION_SCHEMA } from "./postgres-schema.ts";
import type { Pool, PoolClient } from "pg";
import { randomUUID } from "node:crypto";
import { canonicalLedgerCut } from "@harness-anything/kernel/internal/ports/canonical-event-store.ts";
import { parseCanonicalEvent } from "@harness-anything/kernel/internal/domain/doc-sync-canonical-events.ts";
import { canonicalEventEntityRefs } from "@harness-anything/kernel";
import { withPostgresTransaction } from "../postgres/transaction.ts";
import { updateDocumentHeads, type PostgresEventStoreScope } from "../postgres/pg-event-store.ts";
import { createPgTaskProjectionSource } from "../pg/pg-task-source.ts";
import { rebuildPgProjection } from "../pg/pg-task-event-materialize.ts";
import { assertMigrationValue, validateStorageManifest } from "./manifest.ts";
import { auditMigrationProjection } from "./projection.ts";
import { createMigrationGrant } from "./postgres-grant.ts";
import {
  StorageMigrationError,
  type MigrationEndpoint,
  type StorageMigrationRecord,
  type MigrationTuple,
} from "./types.ts";

export async function openPgMigrationEndpoint(input: {
  readonly pool: Pool;
  readonly repoId: string;
  readonly scope: PostgresEventStoreScope;
  readonly backend?: "postgres" | "pglite";
  readonly identity?: string;
}): Promise<MigrationEndpoint> {
  if (
    input.backend !== "pglite" &&
    (await input.pool.query<{ replica: boolean }>("SELECT pg_is_in_recovery() AS replica")).rows[0]!.replica
  )
    throw new StorageMigrationError("storage_migration_primary_required", "migration requires the PostgreSQL primary");
  await withPostgresTransaction(input.pool, async (client) => {
    for (const statement of POSTGRES_STORAGE_MIGRATION_SCHEMA) await client.query(statement);
  });
  const { pool, repoId, scope } = input,
    backend = input.backend ?? "postgres",
    identity = (
      await pool.query<{ identity: string }>(
        "SELECT current_database() || ':' || COALESCE(inet_server_addr()::text,'embedded') || ':' || COALESCE(inet_server_port()::text,'0') AS identity",
      )
    ).rows[0]!.identity,
    key = [scope.tenantId, scope.projectId, repoId],
    transact = <T>(f: (client: PoolClient) => Promise<T>) => withPostgresTransaction(pool, f, scope),
    head = async (client: PoolClient, lock = false) =>
      (
        await client.query<{
          tenant_id: string;
          project_id: string;
          migration_control: StorageMigrationRecord | null;
          activation_markers: Record<string, unknown>;
          writer_epoch: string;
          revision: string;
          head_op_id: string;
          head_event_digest: string;
        }>(`SELECT * FROM ha_repo_heads WHERE repo_id=$1 ORDER BY tenant_id,project_id${lock ? " FOR UPDATE" : ""}`, [
          repoId,
        ])
      ).rows.sort((a, b) =>
        compareTupleOrder(
          { tenantId: a.tenant_id, projectId: a.project_id },
          { tenantId: b.tenant_id, projectId: b.project_id },
        ),
      );
  const exportTuples = async (runId: string): Promise<readonly MigrationTuple[]> => {
    const scopes = (
      await pool.query<{ tenant_id: string; project_id: string; policy_epoch: string; readers: string[] }>(
        "SELECT tenant_id,project_id,policy_epoch,readers FROM ha_repo_heads WHERE repo_id=$1 ORDER BY tenant_id,project_id",
        [repoId],
      )
    ).rows
      .map((row) => ({
        tenantId: row.tenant_id,
        projectId: row.project_id,
        policyEpoch: Number(row.policy_epoch),
        readers: row.readers,
      }))
      .sort(compareTupleOrder);
    if (scopes.length === 0) return [];
    const grant = backend === "postgres" ? await createMigrationGrant(pool, runId, scopes) : null,
      reader = grant?.pool ?? pool,
      tuples: MigrationTuple[] = [];
    try {
      for (const tupleScope of scopes) {
        const tupleKey = [tupleScope.tenantId, tupleScope.projectId, repoId];
        const data = await withPostgresTransaction(
          reader,
          async (client) => {
            const rows = (
                await client.query<Record<string, unknown>>(
                  "SELECT *, COALESCE(recorded_at_text,to_char(recorded_at AT TIME ZONE 'UTC','YYYY-MM-DD\"T\"HH24:MI:SS.MS\"Z\"')) AS stamp FROM ha_events WHERE tenant_id=$1 AND project_id=$2 AND repo_id=$3 ORDER BY revision",
                  tupleKey,
                )
              ).rows,
              events = rows.map((row) => ({
                revision: Number(row.revision),
                opId: String(row.op_id),
                eventJson: String(row.event_json),
                occurredAt: String(row.occurred_at),
                recordedAt: String(row.stamp),
                digest: row.event_digest as `sha256:${string}`,
                readers: row.readers as string[],
                policyEpoch: Number(row.policy_epoch),
              })),
              outcomes = (
                await client.query<Record<string, unknown>>(
                  "SELECT *, COALESCE(recorded_at_text,to_char(recorded_at AT TIME ZONE 'UTC','YYYY-MM-DD\"T\"HH24:MI:SS.MS\"Z\"')) AS stamp FROM ha_command_outcomes WHERE tenant_id=$1 AND project_id=$2 AND repo_id=$3 ORDER BY op_id",
                  tupleKey,
                )
              ).rows
                .map((row) => ({
                  opId: String(row.op_id),
                  status: row.status as "accepted_durable" | "rejected",
                  firstRevision: row.first_revision == null ? null : Number(row.first_revision),
                  lastRevision: row.last_revision == null ? null : Number(row.last_revision),
                  intentDigest: row.intent_digest as `sha256:${string}`,
                  summary: String(row.intent_summary),
                  rejectionCode: row.rejection_code as string | null,
                  recordedAt: String(row.stamp),
                  memberOpIds: row.member_op_ids as string[],
                  readers: row.readers as string[],
                  policyEpoch: Number(row.policy_epoch),
                }))
                .sort((a, b) => (a.opId < b.opId ? -1 : a.opId > b.opId ? 1 : 0)),
              blobs = (
                await client.query<{
                  sha256: string;
                  size: string;
                  body: Buffer;
                  readers: string[];
                  policy_epoch: string;
                }>(
                  "SELECT * FROM ha_content_blobs WHERE tenant_id=$1 AND project_id=$2 ORDER BY sha256",
                  tupleKey.slice(0, 2),
                )
              ).rows.map((row) => ({
                sha256: row.sha256,
                size: Number(row.size),
                bodyBase64: row.body.toString("base64"),
                readers: row.readers,
                policyEpoch: Number(row.policy_epoch),
              }));
            const persisted = (
              await client.query<{ revision: string; head_digest: string | null }>(
                "SELECT revision,head_digest FROM ha_repo_heads WHERE tenant_id=$1 AND project_id=$2 AND repo_id=$3",
                tupleKey,
              )
            ).rows[0]!;
            const derived = canonicalLedgerCut(
              repoId,
              events.at(-1)
                ? { revision: events.at(-1)!.revision, opId: events.at(-1)!.opId, eventDigest: events.at(-1)!.digest }
                : null,
            );
            assertMigrationValue(
              Number(persisted.revision),
              derived.revision,
              "PostgreSQL persisted head revision differs",
            );
            if (derived.revision > 0)
              assertMigrationValue(
                persisted.head_digest,
                derived.headDigest,
                "PostgreSQL persisted headDigest differs",
              );
            const documentHeads = (
              await client.query<{
                path: string;
                sha256: string | null;
                size: string | null;
                node_kind: string | null;
                revision: string;
                readers: string[];
                policy_epoch: string;
              }>(
                "SELECT * FROM ha_document_heads WHERE tenant_id=$1 AND project_id=$2 AND repo_id=$3 ORDER BY path",
                tupleKey,
              )
            ).rows
              .map((row) => ({
                path: row.path,
                sha256: row.sha256,
                size: row.size == null ? null : Number(row.size),
                nodeKind: row.node_kind,
                revision: Number(row.revision),
                readers: row.readers,
                policyEpoch: Number(row.policy_epoch),
              }))
              .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
            return {
              scope: tupleScope,
              documentHeads,
              events,
              outcomes,
              blobs,
              cut: canonicalLedgerCut(
                repoId,
                events.at(-1)
                  ? { revision: events.at(-1)!.revision, opId: events.at(-1)!.opId, eventDigest: events.at(-1)!.digest }
                  : null,
              ),
            };
          },
          tupleScope,
          { isolationLevel: "repeatable read" },
        );
        await auditPgProjectionRows(pool, reader, data);
        const projection = createPgTaskProjectionSource({
          pool: reader,
          repoId,
          scope: { ...tupleScope, readers: [] },
          now: () => "1970-01-01T00:00:00.000Z",
        });
        try {
          tuples.push({ ...data, projection: await auditMigrationProjection(repoId, data, projection) });
        } finally {
          await projection.close();
        }
      }
      return tuples;
    } finally {
      await grant?.close();
    }
  };
  return {
    id: `${backend}:${input.identity ?? identity}:${repoId}`,
    backend,
    state: () =>
      transact(async (client) => {
        const rows = await head(client),
          state = rows[0]?.migration_control ?? null;
        for (const row of rows) assertMigrationValue(row.migration_control, state, "scope migration states disagree");
        return state;
      }),
    marker: (runId) =>
      transact(async (client) => (await head(client)).some((row) => Boolean(row.activation_markers[runId]))),
    epoch: () =>
      transact(async (client) => Math.max(0, ...(await head(client)).map((row) => Number(row.writer_epoch)))),
    export: exportTuples,
    change: (expected, next, activate) =>
      transact(async (client) => {
        await client.query("SET LOCAL synchronous_commit=on");
        await client.query(
          "INSERT INTO ha_repo_heads(tenant_id,project_id,repo_id,readers,policy_epoch) VALUES($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING",
          [...key, scope.readers, scope.policyEpoch],
        );
        const rows = await head(client, true);
        for (const row of rows)
          assertMigrationValue(row.migration_control, expected, "PostgreSQL migration state changed concurrently");
        if (["freezing", "prepared"].includes(next.phase) && rows.some((row) => next.epoch <= Number(row.writer_epoch)))
          throw new StorageMigrationError("storage_migration_conflict", "writer epoch advanced before takeover");
        if (next.role === "target" && next.phase === "prepared") {
          if (
            rows.some((row) => Number(row.revision) !== 0) ||
            (await client.query("SELECT 1 FROM ha_command_outcomes WHERE repo_id=$1 LIMIT 1", [repoId])).rows.length
          )
            throw new StorageMigrationError("storage_migration_target_not_empty", "target changed before prepare");
        }
        if (next.phase === "freezing") {
          assertMigrationValue(
            rows.map((row) => ({
              tenantId: row.tenant_id,
              projectId: row.project_id,
              cut: canonicalLedgerCut(
                repoId,
                Number(row.revision) === 0
                  ? null
                  : {
                      opId: row.head_op_id,
                      revision: Number(row.revision),
                      eventDigest: row.head_event_digest as `sha256:${string}`,
                    },
              ),
            })),
            next.tupleCuts,
            "source changed before epoch takeover",
          );
        }
        await client.query(
          "UPDATE ha_repo_heads SET migration_control=$2::jsonb,writer_epoch=$3,writer_holder_id=$4,activation_markers=CASE WHEN $5 THEN activation_markers || jsonb_build_object($6::text,$2::jsonb) ELSE activation_markers END WHERE repo_id=$1",
          [repoId, JSON.stringify(next), next.epoch, `migration:${next.runId}`, !!activate, next.runId],
        );
      }),
    import: async (manifest) => {
      validateStorageManifest(manifest);
      for (const tuple of manifest.tuples)
        await withPostgresTransaction(
          pool,
          async (client) => {
            const current = (await head(client, true))[0]?.migration_control;
            if (
              current?.runId !== manifest.runId ||
              current.role !== "target" ||
              !["prepared", "activation_failed"].includes(current.phase)
            )
              throw new StorageMigrationError(
                "storage_migration_conflict",
                "PostgreSQL import requires prepared target",
              );
            const s = tuple.scope,
              k = [s.tenantId, s.projectId, repoId];
            await client.query(
              "INSERT INTO ha_repo_heads(tenant_id,project_id,repo_id,readers,policy_epoch,migration_control,writer_epoch,writer_holder_id) VALUES($1,$2,$3,$4,$5,$6::jsonb,$7,$8) ON CONFLICT DO NOTHING",
              [...k, s.readers, s.policyEpoch, JSON.stringify(current), current.epoch, `migration:${manifest.runId}`],
            );
            for (const blob of tuple.blobs)
              await client.query(
                "INSERT INTO ha_content_blobs(tenant_id,project_id,sha256,size,body,readers,policy_epoch) VALUES($1,$2,$3,$4,$5,$6,$7) ON CONFLICT DO NOTHING",
                [
                  s.tenantId,
                  s.projectId,
                  blob.sha256,
                  blob.size,
                  Buffer.from(blob.bodyBase64, "base64"),
                  blob.readers,
                  blob.policyEpoch,
                ],
              );
            for (const row of tuple.events) {
              const event = parseCanonicalEvent(row.eventJson);
              await client.query(
                "INSERT INTO ha_events(tenant_id,project_id,repo_id,revision,op_id,event_id,event_type,event_json,event_digest,occurred_at,actor_refs,entity_refs,readers,policy_epoch,recorded_at,recorded_at_text) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15::text::timestamptz,$15::text) ON CONFLICT DO NOTHING",
                [
                  ...k,
                  row.revision,
                  row.opId,
                  event.eventId,
                  event.type,
                  row.eventJson,
                  row.digest,
                  row.occurredAt,
                  [event.actor.principal.personId, ...(event.actor.executor ? [event.actor.executor.id] : [])],
                  canonicalEventEntityRefs(event),
                  row.readers,
                  row.policyEpoch,
                  row.recordedAt,
                ],
              );
              await updateDocumentHeads(
                client,
                { ...s, readers: row.readers, policyEpoch: row.policyEpoch },
                repoId,
                event as never,
              );
            }
            for (const o of tuple.outcomes)
              await client.query(
                "INSERT INTO ha_command_outcomes(tenant_id,project_id,repo_id,op_id,status,first_revision,last_revision,intent_digest,intent_summary,rejection_code,recorded_at,member_op_ids,readers,policy_epoch,recorded_at_text) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::text::timestamptz,$12,$13,$14,$11::text) ON CONFLICT DO NOTHING",
                [
                  ...k,
                  o.opId,
                  o.status,
                  o.firstRevision,
                  o.lastRevision,
                  o.intentDigest,
                  o.summary,
                  o.rejectionCode,
                  o.recordedAt,
                  o.memberOpIds,
                  o.readers,
                  o.policyEpoch,
                ],
              );
            const last = tuple.events.at(-1);
            await client.query(
              "UPDATE ha_repo_heads SET revision=$4,head_op_id=$5,head_event_digest=$6,head_digest=$7,replication_history=$8 WHERE tenant_id=$1 AND project_id=$2 AND repo_id=$3",
              [
                ...k,
                tuple.cut.revision,
                last?.opId ?? null,
                last?.digest ?? null,
                last ? tuple.cut.headDigest : null,
                randomUUID(),
              ],
            );
            await rebuildPgProjection(client, s, {
              events: tuple.events.map((row) => parseCanonicalEvent(row.eventJson)),
              sourceRevision: tuple.cut.revision,
              readContentBlob: (sha256) => {
                const b = tuple.blobs.find((blob) => blob.sha256 === sha256);
                return b ? Buffer.from(b.bodyBase64, "base64") : null;
              },
              readEventReaders: (event) => tuple.events[event.workspaceRevision - 1]!.readers,
            });
          },
          tuple.scope,
        );
    },
    close: async () => {},
  };
}

function compareTupleOrder(
  left: Pick<PostgresEventStoreScope, "tenantId" | "projectId">,
  right: Pick<PostgresEventStoreScope, "tenantId" | "projectId">,
): number {
  const a = `${left.tenantId}\0${left.projectId}`,
    b = `${right.tenantId}\0${right.projectId}`;
  return a < b ? -1 : a > b ? 1 : 0;
}
