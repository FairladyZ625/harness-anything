import assert from "node:assert/strict";
import type { Pool } from "pg";
import { compileEntityUpsert } from "@harness-anything/kernel/internal/domain/entity-event-compile.ts";
import type { CanonicalEventV1 } from "@harness-anything/kernel";
import { createPgStorageBackend } from "../../src/pg/backend.ts";
import { readPgEntityDeclarations } from "../../src/pg/pg-entity-declarations.ts";
import { rebuildPgProjection } from "../../src/pg/pg-task-event-materialize.ts";
import { withPostgresTransaction } from "../../src/postgres/transaction.ts";
import { tracedPgReads, explainNodes, reportPgVersion, measurePgRead } from "./pg-explain.fixture.ts";
import { bundle, eventAt } from "../store/task-event-store.fixtures.ts";
import { makePostgresTaskEventStore } from "../../src/postgres/pg-task-event-store.ts";
import { borrowPgReadClient } from "../../src/pg/pg-read-savepoint.ts";

export async function assertEntityIndexes(pool: Pool, seedPool: Pool, backend: string) {
  const scope = { tenantId: "entity-index", projectId: "entity-index", policyEpoch: 1 },
    repoId = "entity-index",
    storage = createPgStorageBackend({ pool, scope, repoId }),
    events: CanonicalEventV1[] = [],
    blobs = new Map<string, Uint8Array>();
  await reportPgVersion(pool, backend);
  await withPostgresTransaction(
    pool,
    async (client) => {
      await client.query("SET TRANSACTION READ ONLY");
      const borrowed = await borrowPgReadClient(client);
      try {
        await borrowed.query("BEGIN");
        await borrowed.query("SELECT set_config('ha.tenant_id','nested-scope',true)");
        await borrowed.query("COMMIT");
      } finally {
        await borrowed.release();
      }
      assert.equal(
        (await client.query<{ tenant: string }>("SELECT current_setting('ha.tenant_id') AS tenant")).rows[0]!.tenant,
        scope.tenantId,
      );
    },
    scope,
  );
  for (const [i, id] of ["target-a", "target-b", "target-c"].entries()) {
    const candidate = compileEntityUpsert({
      eventId: `entity-index-${i}`,
      opId: `entity-index-${i}`,
      workspaceRevision: i + 1,
      actor: { principal: { personId: "index" }, executor: null },
      source: "local",
      occurredAt: "2026-11-04T00:00:00.000Z",
      entityKind: "agent",
      entity: { schema: "agent-declaration/v1", id, name: id, instructions: "indexed", runtimes: [{ type: "codex" }] },
    });
    await storage.eventStore.append(candidate, i, { repoId, holderId: "index", epoch: 1 });
    events.push(candidate.event);
    for (const blob of candidate.blobs) blobs.set(blob.sha256, new TextEncoder().encode(blob.body));
  }
  await withPostgresTransaction(
    seedPool,
    async (client) => {
      await client.query(
        `INSERT INTO ha_entity_declaration_heads
      (tenant_id,project_id,policy_epoch,entity_kind,entity_id,state,live,workspace_revision)
      SELECT $1,$2,$3,'agent','deleted-' || lpad(n::text,6,'0'),'{"declaration":null,"retirement":null}',false,3
      FROM generate_series(1,100000) n`,
        [scope.tenantId, scope.projectId, scope.policyEpoch],
      );
      await client.query("ANALYZE ha_entity_declaration_heads");
    },
    scope,
  );
  const plans: unknown[] = [],
    traced = tracedPgReads(pool, plans, (sql) =>
      /^\s*SELECT[\s\S]*(?:ha_entity_declaration_heads|ha_repo_heads)/u.test(sql),
    ),
    read = (query: Parameters<typeof readPgEntityDeclarations>[3], connection = traced) =>
      withPostgresTransaction(connection, (client) => readPgEntityDeclarations(client, scope, repoId, query), scope);
  const before = await read({ kind: "agent" });
  assert.deepEqual(
    before.map((row) => row.declaration!.payload.entityId),
    ["target-a", "target-b", "target-c"],
  );
  assert.equal((await read({ kind: "agent", id: "target-b", limit: 1 })).length, 1);
  assert.deepEqual(await read({ kind: "agent", id: "deleted-000001", limit: 1 }), []);
  assert.equal((await read({ kind: "agent", limit: 1 })).length, 1);
  for (const node of explainNodes(plans).filter((row) => typeof row["Relation Name"] === "string")) {
    const examined =
      (Number(node["Actual Rows"] ?? 0) + Number(node["Rows Removed by Filter"] ?? 0)) *
      Number(node["Actual Loops"] ?? 1);
    assert.ok(examined <= 3, `${backend} current declarations examined ${examined} rows: ${JSON.stringify(node)}`);
  }
  await measurePgRead(backend, "entity.get", () => read({ kind: "agent", id: "target-b", limit: 1 }, pool));
  await measurePgRead(backend, "entity.list", () => read({ kind: "agent" }, pool));
  await withPostgresTransaction(
    seedPool,
    async (client) => {
      await client.query(
        "UPDATE ha_projection_meta SET entity_declaration_watermark=0 WHERE tenant_id=$1 AND project_id=$2 AND policy_epoch=$3",
        [scope.tenantId, scope.projectId, scope.policyEpoch],
      );
      await client.query(
        "DELETE FROM ha_entity_declaration_heads WHERE tenant_id=$1 AND project_id=$2 AND policy_epoch=$3",
        [scope.tenantId, scope.projectId, scope.policyEpoch],
      );
    },
    scope,
  );
  await assert.rejects(read({ kind: "agent" }, pool), { code: "projection_pending" });
  const later = bundle(eventAt(4));
  await storage.eventStore.append(later, 3, { repoId, holderId: "index", epoch: 1 });
  events.push(later.event);
  await assert.rejects(read({ kind: "agent" }, pool), { code: "projection_pending" });
  await withPostgresTransaction(
    seedPool,
    (client) =>
      rebuildPgProjection(client, scope, {
        events,
        sourceRevision: 4,
        readContentBlob: (sha256) => blobs.get(sha256) ?? null,
      }),
    scope,
  );
  assert.deepEqual(await read({ kind: "agent" }, pool), before);
  const unprojected = compileEntityUpsert({
    eventId: "entity-gap",
    opId: "entity-gap",
    workspaceRevision: 5,
    actor: { principal: { personId: "index" }, executor: null },
    source: "local",
    occurredAt: "2026-11-04T00:00:00.000Z",
    entityKind: "agent",
    entity: {
      schema: "agent-declaration/v1",
      id: "target-a",
      name: "Updated in canonical gap",
      instructions: "Cannot promote an incomplete index",
      runtimes: [{ type: "codex" }],
    },
  });
  await makePostgresTaskEventStore({ pool, repoId, scope: { ...scope, readers: [] } }).append(unprojected, 4, {
    repoId,
    holderId: "index",
    epoch: 1,
  });
  events.push(unprojected.event);
  for (const blob of unprojected.blobs) blobs.set(blob.sha256, new TextEncoder().encode(blob.body));
  await assert.rejects(read({ kind: "agent" }, pool), { code: "projection_pending" });
  const tail = bundle(eventAt(6));
  await storage.eventStore.append(tail, 5, { repoId, holderId: "index", epoch: 1 });
  events.push(tail.event);
  await assert.rejects(read({ kind: "agent" }, pool), { code: "projection_pending" });
  await withPostgresTransaction(
    seedPool,
    (client) =>
      rebuildPgProjection(client, scope, {
        events,
        sourceRevision: 6,
        readContentBlob: (sha256) => blobs.get(sha256) ?? null,
      }),
    scope,
  );
  assert.deepEqual((await read({ kind: "agent", id: "target-a" }, pool))[0]!.declaration, unprojected.event);
}
