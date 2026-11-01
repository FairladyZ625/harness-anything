// harness-test-tier: integration
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { createPgDialectStorageBackend, createPGliteStorage } from "../../src/index.ts";
import { withPostgresTransaction } from "../../src/postgres/transaction.ts";
import { resolveStorageBackend } from "../../src/storage-backend.ts";
import { makeTaskEventStore } from "../../src/store/task-event-store.ts";
import { bundle, eventAt, initRepo } from "../store/task-event-store.fixtures.ts";

const claims = { tenantId: "tenant-a", projectId: "project-a", policyEpoch: 7 } as const;

test("PGlite storage persists PostgreSQL transactions and clears local scope claims", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "ha-pglite-foundation-"));
  const storage = createPGliteStorage({ dataDir: root });
  try {
    await withPostgresTransaction(
      storage.pool,
      async (client) => {
        await client.query("CREATE TABLE pglite_probe (id text PRIMARY KEY, payload text NOT NULL)");
        const scoped = await client.query<{ tenantId: string; projectId: string; policyEpoch: string }>(
          'SELECT current_setting($1) AS "tenantId", current_setting($2) AS "projectId", current_setting($3) AS "policyEpoch"',
          ["ha.tenant_id", "ha.project_id", "ha.policy_epoch"],
        );
        assert.deepEqual(scoped.rows[0], { tenantId: claims.tenantId, projectId: claims.projectId, policyEpoch: "7" });
        await client.query("INSERT INTO pglite_probe (id, payload) VALUES ($1, $2)", ["one", "committed"]);
      },
      claims,
    );
    await assert.rejects(
      withPostgresTransaction(storage.pool, async (client) => {
        await client.query("INSERT INTO pglite_probe (id, payload) VALUES ($1, $2)", ["two", "rolled-back"]);
        throw new Error("rollback witness");
      }),
      /rollback witness/u,
    );
    assert.deepEqual((await storage.db.query("SELECT id, payload FROM pglite_probe ORDER BY id")).rows, [
      { id: "one", payload: "committed" },
    ]);
    assert.deepEqual((await storage.db.query("SELECT current_setting('ha.tenant_id', true) AS tenant_id")).rows, [
      { tenant_id: "" },
    ]);
  } finally {
    await storage.close();
  }

  const reopened = createPGliteStorage({ dataDir: root });
  try {
    assert.deepEqual((await reopened.db.query("SELECT payload FROM pglite_probe")).rows, [{ payload: "committed" }]);
  } finally {
    await reopened.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("PGlite node-postgres bridge exposes one connection and the shared transaction contract", async () => {
  const storage = createPGliteStorage({ dataDir: "memory://ha-pglite-pool-contract" });
  try {
    assert.equal(storage.pool.options.max, 1);
    assert.equal(storage.db.closed, false);
    await withPostgresTransaction(
      storage.pool,
      async (client) => {
        await client.query("CREATE TABLE pglite_pool_probe (value integer NOT NULL)");
        await client.query("INSERT INTO pglite_pool_probe VALUES ($1)", [7]);
      },
      claims,
    );
    assert.deepEqual((await storage.pool.query("SELECT value FROM pglite_pool_probe")).rows, [{ value: 7 }]);
  } finally {
    await storage.close();
  }
  assert.equal(storage.db.closed, true);
});

test("PGlite records its deliberate single-user/RLS boundary instead of claiming PG role isolation", async () => {
  const storage = createPGliteStorage({ dataDir: "memory://ha-pglite-capabilities" });
  try {
    const identity = await storage.db.query<{ currentUser: string; superuser: boolean; bypassRls: boolean }>(
      'SELECT current_user AS "currentUser", rolsuper AS superuser, rolbypassrls AS "bypassRls" FROM pg_roles WHERE rolname = current_user',
    );
    assert.deepEqual(identity.rows[0], { currentUser: "postgres", superuser: true, bypassRls: true });
    await storage.db.exec(
      "CREATE TABLE pglite_rls_probe (tenant_id text NOT NULL, payload text NOT NULL); " +
        "ALTER TABLE pglite_rls_probe ENABLE ROW LEVEL SECURITY; " +
        "ALTER TABLE pglite_rls_probe FORCE ROW LEVEL SECURITY; " +
        "CREATE POLICY pglite_rls_probe_scope ON pglite_rls_probe USING (tenant_id = current_setting('ha.tenant_id', true)) WITH CHECK (tenant_id = current_setting('ha.tenant_id', true));",
    );
    await storage.db.query("INSERT INTO pglite_rls_probe VALUES ($1, $2), ($3, $4)", [
      "tenant-a",
      "visible",
      "tenant-b",
      "superuser-visible",
    ]);
    const rows = await withPostgresTransaction(
      storage.pool,
      (client) => client.query("SELECT tenant_id, payload FROM pglite_rls_probe ORDER BY tenant_id"),
      claims,
    );
    assert.equal(rows.rows.length, 2);
  } finally {
    await storage.close();
  }
});

test("pglite backend config resolves without leaking a PostgreSQL connection string", () => {
  assert.deepEqual(
    resolveStorageBackend({ storage: { backend: "pglite", dataDir: "./studio-pgdata", scope: claims } }),
    {
      backend: "pglite",
      dataDir: "./studio-pgdata",
      scope: claims,
    },
  );
});

test("PGlite composes the PG ledger and projection ports with SQLite cut parity", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "ha-pglite-contract-")),
    dataDir = mkdtempSync(path.join(tmpdir(), "ha-pglite-ledger-")),
    repoId = "pglite-contract-repo",
    storageConfig = { backend: "pglite", dataDir, scope: { ...claims, readers: ["reader-a"] } } as const;
  initRepo(root);
  const sqlite = makeTaskEventStore({ repoId, rootDir: root }),
    write = bundle(eventAt(1));
  const sqliteReceipt = sqlite.append(write);
  let backend = await createPgDialectStorageBackend({ repoId, storage: storageConfig });
  try {
    const receipt = await backend.eventStore.append(write, 0, { repoId, holderId: "center", epoch: 1 });
    assert.deepEqual(receipt.cut, sqliteReceipt.cut);
    assert.deepEqual(
      (await backend.eventStore.append(write, 0, { repoId, holderId: "center", epoch: 1 })).cut,
      receipt.cut,
    );
    const conflictingWrite = bundle({
      ...write.event,
      payload: { task: { ...write.event.payload.task, title: "Conflicting intent" } },
    });
    await assert.rejects(backend.eventStore.append(conflictingWrite, 1, { repoId, holderId: "center", epoch: 1 }), {
      code: "op_conflict",
    });
    assert.deepEqual(await backend.eventStore.execute({ operation: "events" }), [eventAt(1)]);
    assert.equal((await backend.projection.readCut()).status, "ready");
    assert.equal((await backend.projection.readSnapshot("task-00001"))?.task?.title, "Task 00001");
    assert.equal((await backend.projection.readCut()).watermark, 1);
    await backend.entities.persist({
      kind: "agent",
      id: "pglite-agent",
      value: {
        schema: "agent-declaration/v1",
        id: "pglite-agent",
        name: "PGlite Agent",
        instructions: "work",
        runtimes: [{ type: "codex" }],
      },
      workspaceRevision: 1,
      extensionMetadata: { source: "pglite-contract" },
    });
    assert.deepEqual((await backend.entities.get("agent", "pglite-agent"))?.extensionMetadata, {
      source: "pglite-contract",
    });
  } finally {
    await backend.close();
  }

  backend = await createPgDialectStorageBackend({ repoId, storage: storageConfig });
  try {
    assert.equal((await backend.eventStore.readHead())?.revision, 1);
    assert.equal((await backend.projection.readCut()).status, "ready");
    assert.equal((await backend.projection.readSnapshot("task-00001"))?.task?.title, "Task 00001");
    assert.deepEqual((await backend.entities.get("agent", "pglite-agent"))?.extensionMetadata, {
      source: "pglite-contract",
    });
  } finally {
    await backend.close();
    rmSync(root, { recursive: true, force: true });
    rmSync(dataDir, { recursive: true, force: true });
  }
});
