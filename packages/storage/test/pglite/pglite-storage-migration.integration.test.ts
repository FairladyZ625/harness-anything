// harness-test-tier: integration
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createPGliteStorageBackend } from "../../src/pglite/storage-backend.ts";
import { openPgMigrationEndpoint } from "../../src/migration/postgres-endpoint.ts";
import { migrateStorage } from "../../src/migration/engine.ts";
import { runStorageMigration } from "../../src/migration/open.ts";
import { startManagedPostgresFixture } from "../postgres/managed-postgres.fixture.ts";
import { ensurePgProjectionSchema } from "../../src/pg/pg-projection-schema.ts";
import { POSTGRES_EVENT_LEDGER_SCHEMA_STATEMENTS } from "../../src/postgres/event-ledger-schema.ts";
import { withPostgresTransaction } from "../../src/postgres/transaction.ts";
import { createPgStorageBackend } from "../../src/pg/backend.ts";
import { bundle, docBundle, eventAt } from "../store/task-event-store.fixtures.ts";
import { pgliteIntegrationSuite } from "./pglite-runtime.fixture.ts";
import { test } from "node:test";

pgliteIntegrationSuite("PGlite/PostgreSQL cold storage migration", () => {
  test("Node 26: bidirectional byte, digest and projection reconciliation uses the same durable state machine", async () => {
    const repoId = "migration",
      scope = { tenantId: "tenant-migration", projectId: "project-migration", policyEpoch: 0, readers: [] },
      fixture = await startManagedPostgresFixture(),
      root = mkdtempSync(path.join(tmpdir(), "ha-pglite-migration-")),
      sourceConfig = { backend: "pglite", dataDir: path.join(root, "source"), scope } as const,
      targetConfig = { backend: "pglite", dataDir: path.join(root, "target"), scope } as const;
    let a = await createPGliteStorageBackend({ repoId, storage: sourceConfig }),
      b = await createPGliteStorageBackend({ repoId, storage: targetConfig });
    try {
      await withPostgresTransaction(fixture.adminPool, async (client) => {
        for (const sql of POSTGRES_EVENT_LEDGER_SCHEMA_STATEMENTS) await client.query(sql);
        await ensurePgProjectionSchema(client);
      });
      await a.eventStore.append(bundle(eventAt(1)), 0, { repoId, holderId: "seed", epoch: 1 });
      const cut = await a.eventStore.currentCut();
      await a.eventStore.append(
        docBundle({ currentCut: () => cut } as never, "PGlite\0台账😀\n", 2, "op-nul", "docs/value.md"),
        1,
        { repoId, holderId: "seed", epoch: 1 },
      );
      const source = await openPgMigrationEndpoint({
          pool: a.pool,
          repoId,
          scope,
          backend: "pglite",
          identity: "source",
        }),
        pg = await openPgMigrationEndpoint({ pool: fixture.adminPool, repoId, scope }),
        target = await openPgMigrationEndpoint({ pool: b.pool, repoId, scope, backend: "pglite", identity: "target" }),
        before = await source.export("pglite-pg");
      const forwardInput = {
        repoId,
        runId: "pglite-pg",
        source,
        target: pg,
        exportDirectory: path.join(root, "forward"),
      };
      await assert.rejects(
        migrateStorage({
          ...forwardInput,
          checkpoint(boundary) {
            if (boundary === "source_sealed") throw new Error("PGlite sealed process interruption");
          },
        }),
        /PGlite sealed process interruption/,
      );
      await a.close();
      a = await createPGliteStorageBackend({ repoId, storage: sourceConfig });
      const reopenedSource = await openPgMigrationEndpoint({
        pool: a.pool,
        repoId,
        scope,
        backend: "pglite",
        identity: "source",
      });
      await assert.rejects(
        createPgStorageBackend({
          pool: a.pool,
          repoId,
          scope: { ...scope, tenantId: "unseen-after-reopen" },
        }).eventStore.append(bundle(eventAt(1)), 0, { repoId, holderId: "late", epoch: 100 }),
        /storage_migration_read_only/,
      );
      await migrateStorage({ ...forwardInput, source: reopenedSource, mode: "resume" });
      assert.equal(before[0]!.blobs.length, 1);
      assert.deepEqual(await pg.export("pglite-pg"), before);
      await assert.rejects(
        a.eventStore.append(bundle(eventAt(3)), 2, { repoId, holderId: "stale", epoch: 100 }),
        /storage_migration_read_only/,
      );
      const backwardInput = {
        repoId,
        runId: "pg-pglite",
        source: pg,
        target,
        exportDirectory: path.join(root, "backward"),
      };
      await assert.rejects(
        migrateStorage({
          ...backwardInput,
          checkpoint(boundary) {
            if (boundary === "target_marker") throw new Error("PGlite marker acknowledgement lost");
          },
        }),
        /PGlite marker acknowledgement lost/,
      );
      await b.close();
      b = await createPGliteStorageBackend({ repoId, storage: targetConfig });
      const reopenedTarget = await openPgMigrationEndpoint({
        pool: b.pool,
        repoId,
        scope,
        backend: "pglite",
        identity: "target",
      });
      await migrateStorage({ ...backwardInput, target: reopenedTarget, mode: "resume" });
      assert.deepEqual(await reopenedTarget.export("pg-pglite"), before);
      process.stdout.write(
        `PGLITE_MIGRATION_NODE ${process.versions.node} ROUNDTRIP ${JSON.stringify(before.map((tuple) => tuple.cut))}\n`,
      );
    } finally {
      await a.close();
      await b.close();
      await fixture.close();
      rmSync(root, { recursive: true, force: true });
    }
  });
});

if (Number(process.versions.node.split(".")[0]) < 26) {
  test("Node 24 migration API refuses PGlite before opening a target", async () => {
    await assert.rejects(
      runStorageMigration({
        repoId: "unsupported",
        runId: "node24",
        exportDirectory: "/unused-export",
        source: {
          storage: {
            backend: "pglite",
            dataDir: "/unused-pglite",
            scope: { tenantId: "t", projectId: "p", policyEpoch: 0 },
          },
        },
        target: {
          rootDir: "/unused-target",
          storage: { backend: "sqlite", scope: { tenantId: "t", projectId: "p", policyEpoch: 0 } },
        },
      }),
      { code: "pglite_runtime_unsupported" },
    );
  });
}
