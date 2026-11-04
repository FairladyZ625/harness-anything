import { randomUUID } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import { parseCanonicalEvent } from "@harness-anything/kernel/internal/domain/doc-sync-canonical-events.ts";
import { ensurePgProjectionSchema, PG_PROJECTION_TABLES } from "../pg/pg-projection-schema.ts";
import { rebuildPgProjection } from "../pg/pg-task-event-materialize.ts";
import { withPostgresTransaction } from "../postgres/transaction.ts";
import { canonicalJson } from "../projection/rebuildable-task-projection-sql.ts";
import { assertMigrationValue } from "./manifest.ts";
import type { MigrationTuple } from "./types.ts";

async function rows(client: PoolClient, tuple: Pick<MigrationTuple, "scope">) {
  const result: Record<string, unknown> = {},
    scope = tuple.scope;
  for (const table of PG_PROJECTION_TABLES) {
    const values = (
      await client.query<{ value: Record<string, unknown> }>(
        `SELECT to_jsonb(p) - 'updated_at' - 'state_digest' AS value FROM ${table} p WHERE tenant_id=$1 AND project_id=$2 AND policy_epoch=$3`,
        [scope.tenantId, scope.projectId, scope.policyEpoch],
      )
    ).rows.map((row) => row.value);
    result[table] = values.sort((a, b) => canonicalJson(a).localeCompare(canonicalJson(b)));
  }
  return result;
}
/** A same-dialect replay compares every physical projection row, including models without public list methods.
 * Wall-clock cache timestamps and the optional lazily-computed digest are excluded; every other column remains.
 * The management transaction owns an isolated schema; exported source rows are read only by the granted login.
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
        `CREATE TABLE "${schema}".ha_events (LIKE ha_events INCLUDING DEFAULTS INCLUDING CONSTRAINTS)`,
      );
      await client.query(
        `INSERT INTO "${schema}".ha_events SELECT * FROM ha_events
          WHERE tenant_id=$1 AND project_id=$2 AND policy_epoch=$3 AND repo_id=$4 AND revision<=$5`,
        [tuple.scope.tenantId, tuple.scope.projectId, tuple.scope.policyEpoch, tuple.cut.repoId, tuple.cut.revision],
      );
      await client.query(`SET LOCAL search_path TO "${schema}", public`);
      await ensurePgProjectionSchema(client);
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
  );
}
