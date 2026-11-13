import { pgProjectionStoredRows } from "../pg/pg-projection-stored-rows.ts";
import { randomUUID } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import { parseCanonicalEvent } from "@harness-anything/kernel/internal/domain/doc-sync-canonical-events.ts";
import { ensurePgProjectionSchema, PG_PROJECTION_AUDIT_TABLES } from "../pg/pg-projection-schema.ts";
import { rebuildPgProjection } from "../pg/pg-task-event-materialize.ts";
import { withPostgresTransaction } from "../postgres/transaction.ts";
import { canonicalJson } from "../projection/rebuildable-task-projection-sql.ts";
import { assertMigrationValue } from "./manifest.ts";
import type { MigrationTuple } from "./types.ts";

async function rows(client: PoolClient, tuple: Pick<MigrationTuple, "scope">) {
  const result: Record<string, unknown> = {},
    scope = tuple.scope;
  for (const table of PG_PROJECTION_AUDIT_TABLES) {
    const stored = pgProjectionStoredRows(table),
      values = (
        await client.query<{ value: Record<string, unknown> }>(
          `SELECT (${stored.row})-'updated_at'-'state_digest' AS value FROM ${stored.from}
         WHERE projection.tenant_id=$1 AND projection.project_id=$2 AND projection.policy_epoch=$3`,
          [scope.tenantId, scope.projectId, scope.policyEpoch],
        )
      ).rows.map((row) => row.value);
    result[table] = values.sort((a, b) => canonicalJson(a).localeCompare(canonicalJson(b)));
  }
  return result;
}
/** A same-dialect replay compares complete model values, including models without public lists.
 * Allocation slots resolve to exact words; unused dictionary addresses have no search meaning.
 * Every posting column remains. Wall-clock timestamps and the lazily computed digest are excluded.
 * The management transaction owns an isolated schema; the source is read by its granted login.
 */
export async function auditPgProjectionRows(
  admin: Pool,
  reader: Pool,
  tuple: Omit<MigrationTuple, "projection">,
): Promise<void> {
  const actual = await withPostgresTransaction(reader, (client) => rows(client, tuple), tuple.scope, {
      isolationLevel: "repeatable read",
    }),
    schema = `ha_replay_${randomUUID().replaceAll("-", "")}`;
  await withPostgresTransaction(
    admin,
    async (client) => {
      await client.query(`CREATE SCHEMA "${schema}"`);
      // Read-index DDL and replay triggers must own their event table too. Resolving
      // ha_events through the public fallback would change the source's triggers.
      await client.query(
        /* @gate-identity state-store/migration.source.storage.src.migration.postgres-projection-audit.postgres-database */ `CREATE TABLE "${schema}".ha_events (LIKE ha_events INCLUDING DEFAULTS INCLUDING CONSTRAINTS)`,
      );
      await client.query(
        `INSERT INTO "${schema}".ha_events SELECT * FROM ha_events
          WHERE tenant_id=$1 AND project_id=$2 AND policy_epoch=$3 AND repo_id=$4 AND revision<=$5`,
        [tuple.scope.tenantId, tuple.scope.projectId, tuple.scope.policyEpoch, tuple.cut.repoId, tuple.cut.revision],
      );
      // Event triggers must resolve the replay's own derived ref index as well.
      await client.query(
        /* @gate-identity state-store/migration.source.storage.src.migration.postgres-projection-audit.postgres-database */ `CREATE TABLE "${schema}".ha_event_entity_refs (LIKE ha_event_entity_refs INCLUDING ALL)`,
      );
      await client.query(
        `INSERT INTO "${schema}".ha_event_entity_refs SELECT * FROM ha_event_entity_refs
          WHERE tenant_id=$1 AND project_id=$2 AND policy_epoch=$3 AND repo_id=$4 AND revision<=$5`,
        [tuple.scope.tenantId, tuple.scope.projectId, tuple.scope.policyEpoch, tuple.cut.repoId, tuple.cut.revision],
      );
      await client.query(`SET LOCAL search_path TO "${schema}", public`);
      await ensurePgProjectionSchema(client, { indexBuild: "isolated" });
      await rebuildPgProjection(client, tuple.scope, {
        events: tuple.events.map((row) => parseCanonicalEvent(row.eventJson)),
        sourceRevision: tuple.cut.revision,
        readEventReaders: (event) => tuple.events[event.workspaceRevision - 1]!.readers,
        readContentBlob: (sha256) => {
          const blob = tuple.blobs.find((value) => value.sha256 === sha256);
          return blob ? Buffer.from(blob.bodyBase64, "base64") : null;
        },
      });
      const expected = await rows(client, tuple);
      assertMigrationValue(actual, expected, "complete PostgreSQL projection rows differ from canonical replay");
      await client.query(`DROP SCHEMA "${schema}" CASCADE`);
    },
    tuple.scope,
    { rollbackOnly: () => true },
  );
}
