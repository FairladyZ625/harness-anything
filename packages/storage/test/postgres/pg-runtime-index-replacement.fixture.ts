import assert from "node:assert/strict";
import type { Pool } from "pg";
import type { PgProjectionScope } from "../../src/pg/pg-task-event-materialize.ts";
import { createPgStorageBackend } from "../../src/pg/backend.ts";
import { canonicalEventWritePlan } from "../../src/store/task-event-store.ts";
import { runtimeProviderEvents } from "../runtime-provider-bytes.assertions.ts";
import { ensurePgProjectionSchema } from "../../src/pg/pg-projection-schema.ts";
import { withPostgresTransaction } from "../../src/postgres/transaction.ts";

/** Candidate exception, isolated fixture ONLY: preserve every table, column and canonical byte. */
export async function assertRuntimeIndexReplacement(
  pool: Pool,
  schemaPool: Pool,
  scope: PgProjectionScope,
): Promise<void> {
  await schemaPool.query(
    "CREATE INDEX ha_projection_values_runtime_unsettled ON ha_projection_values (tenant_id,project_id,policy_epoch,((value::jsonb)->>'outcome')) WHERE model='runtime-session'",
  );
  // Reopen through the real schema expansion path, not a test-only repair implementation.
  await withPostgresTransaction(schemaPool, ensurePgProjectionSchema);
  const repoId = "provider-replacement",
    backend = createPgStorageBackend({ pool, scope, repoId });
  for (const event of runtimeProviderEvents())
    await backend.eventStore.append(
      { event, plan: canonicalEventWritePlan(event, "agent-runtime/v1", event.opId), blobs: [] },
      event.workspaceRevision - 1,
      { repoId, holderId: "fixture", epoch: 1 },
    );
  assert.equal(
    (await backend.projection.readRuntimeSession("runtime-provider-bytes"))!.providerSessionId,
    "opaque\0provider",
  );
  assert.equal((await backend.projection.readRuntimeSessions({ unsettledOnly: true })).length, 1);
}
