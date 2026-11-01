// harness-test-tier: integration
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { Pool } from "pg";
import {
  createPgEntityStore,
  createPgTaskProjectionSource,
  ensurePgProjectionSchema,
  grantPgProjectionRuntimeAccess,
  materializePgProjectionEvent,
} from "../../src/pg/index.ts";
import { createPostgresPool, withPostgresTransaction } from "../../src/postgres/index.ts";
import { POSTGRES_SCOPE_SCHEMA_CONTRACT } from "../../src/postgres/scope-schema.ts";
import { startManagedPostgresFixture } from "./managed-postgres.fixture.ts";
import { event } from "../store/task-event-store.fixtures.ts";

test("PG task projection materializes reduceTaskEvent snapshots and scopes readers", async () => {
  const fixture = await startManagedPostgresFixture();
  const pools: Pool[] = [];
  try {
    const database = `ha_projection_${randomUUID().replaceAll("-", "")}`;
    await fixture.adminPool.query(`CREATE DATABASE "${database}"`);
    const adminPool = new Pool({ host: "127.0.0.1", port: fixture.port, user: "postgres", database, max: 1 });
    pools.push(adminPool);
    const runtimePassword = randomUUID().replaceAll("-", ""),
      runtimePool = createPostgresPool(
        `postgres://${POSTGRES_SCOPE_SCHEMA_CONTRACT.roles.runtime}:${runtimePassword}@127.0.0.1:${fixture.port}/${database}`,
        { max: 1 },
      );
    pools.push(runtimePool);
    const { roles, roleAttributes } = POSTGRES_SCOPE_SCHEMA_CONTRACT;
    await adminPool.query(`CREATE ROLE "${roles.schemaOwner}" ${roleAttributes.schemaOwner}`);
    await adminPool.query(`CREATE ROLE "${roles.runtime}" ${roleAttributes.runtime} PASSWORD '${runtimePassword}'`);
    await adminPool.query(`CREATE ROLE "${roles.migration}" ${roleAttributes.migration}`);
    await adminPool.query(`GRANT CREATE ON SCHEMA public TO "${roles.schemaOwner}"`);
    await withPostgresTransaction(adminPool, async (client) => {
      await client.query(`SET ROLE "${roles.schemaOwner}"`);
      try {
        await ensurePgProjectionSchema(client);
      } finally {
        await client.query("RESET ROLE");
      }
      await grantPgProjectionRuntimeAccess(client);
    });
    await withPostgresTransaction(
      runtimePool,
      (client) =>
        materializePgProjectionEvent(
          client,
          { tenantId: "tenant-a", projectId: "project-a", policyEpoch: 7, readers: ["reader-a"] },
          { event },
        ),
      { tenantId: "tenant-a", projectId: "project-a", policyEpoch: 7 },
    );
    const source = createPgTaskProjectionSource({
      pool: runtimePool,
      scope: { tenantId: "tenant-a", projectId: "project-a", policyEpoch: 7, readers: ["reader-a"] },
    });
    const read = await source.read(event.taskId),
      list = await source.list({ taskIds: [event.taskId] }),
      cut = await source.readCut();
    assert.equal(read.status, "ready");
    assert.equal(read.snapshot.task?.taskId, event.taskId);
    assert.deepEqual(
      list.rows.map((row) => row.taskId),
      [event.taskId],
    );
    assert.deepEqual(cut, { status: "ready", watermark: 1, sourceRevision: 1 });
    const hidden = createPgTaskProjectionSource({
      pool: runtimePool,
      scope: { tenantId: "tenant-b", projectId: "project-a", policyEpoch: 7, readers: ["reader-a"] },
    });
    assert.equal((await hidden.read(event.taskId)).snapshot.task, null);
    const entities = createPgEntityStore({
      pool: runtimePool,
      scope: { tenantId: "tenant-a", projectId: "project-a", policyEpoch: 7, readers: ["reader-a"] },
    });
    await entities.persist({
      kind: "agent",
      id: "codex",
      value: {
        schema: "agent-declaration/v1",
        id: "codex",
        name: "Codex",
        instructions: "work",
        runtimes: [{ type: "codex" }],
      },
      workspaceRevision: 2,
      documentPath: "agents/codex.json",
      documentSha256: "sha256:entity",
      extensionMetadata: { team: "platform" },
    });
    assert.deepEqual((await entities.get("agent", "codex"))?.extensionMetadata, { team: "platform" });
    await source.close();
    await hidden.close();
    await entities.close();
  } finally {
    await Promise.all(pools.map((pool) => pool.end()));
    await fixture.close();
  }
});
