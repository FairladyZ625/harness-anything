// harness-test-tier: integration
import assert from "node:assert/strict";
import { join } from "node:path";
import test from "node:test";
import { createPGliteStorageBackend } from "../../src/pglite/storage-backend.ts";
import { createPGliteTaskQueryReader } from "../../src/pglite/query-owner.ts";
import { withPostgresTransaction } from "../../src/postgres/transaction.ts";
import {
  artifactRetirementEntry,
  flushPgArtifactDocuments,
  readPgArtifactTimeline,
} from "../../src/pg/pg-artifact-timeline.ts";
import {
  artifactScope as scope,
  artifactRepo as repoId,
  artifactPath,
  seedArtifactUpgrade,
  replaceArtifact,
} from "../postgres/pg-artifact-online.fixture.ts";
import { withTempStoreAsync } from "../store/helpers.ts";
import { pgliteIntegrationSuite } from "./pglite-runtime.fixture.ts";

type Backend = Awaited<ReturnType<typeof createPGliteStorageBackend>>;
const progress = async (backend: Backend) =>
  (await backend.pool.query("SELECT phase,cursor,upper_bound FROM ha_artifact_backfill")).rows[0];
const version = async (backend: Backend) =>
  (await backend.pool.query("SELECT artifact_index_version FROM ha_projection_meta")).rows[0]!.artifact_index_version;

pgliteIntegrationSuite("artifact migration uses the online writer queue", () => {
  for (const [size, readers] of [
    [10000, 1],
    [100000, 4],
  ] as const) {
    test(`owner admits reads before migrating ${size} artifacts with ${readers} readers`, async (t) => {
      await withTempStoreAsync(async (root) => {
        const storage = { backend: "pglite" as const, dataDir: join(root, "db"), scope },
          original = await createPGliteStorageBackend({ repoId, storage });
        try {
          assert.deepEqual(await original.backfillReadIndexes(), { processed: 0, done: true });
          assert.equal((await original.projection.readArtifactTimelinePage({ kind: "html", limit: 1 })).rows.length, 0);
          await withPostgresTransaction(original.pool, (client) => seedArtifactUpgrade(client, size, readers), scope);
        } finally {
          await original.close();
        }
        const started = performance.now(),
          owner = createPGliteTaskQueryReader({ repoId, storage, scope });
        const attachedMs = performance.now() - started;
        try {
          assert.equal(
            owner.withSession((q) => q.readDocumentMetadata(artifactPath(size))).document?.workspaceRevision,
            size,
          );
          const readAvailableMs = performance.now() - started;
          t.diagnostic(
            `ARTIFACT_OWNER_ATTACH ${JSON.stringify({ artifacts: size, readers, attachedMs, readAvailableMs })}`,
          );
          assert.throws(() => owner.withSession((q) => q.readArtifactTimelinePage({ kind: "html", limit: 1 })), {
            code: "projection_pending",
          });
        } finally {
          owner.close();
        }
        let backend = await createPGliteStorageBackend({ repoId, storage });
        try {
          assert.equal(await version(backend), 0);
          assert.equal(await progress(backend), undefined, "open must not even start a cleanup page");
          await backend.pool.query("SELECT ha_backfill_artifact_documents($1,$2,$3,$4)", [
            scope.tenantId,
            scope.projectId,
            scope.policyEpoch,
            repoId,
          ]);
          await backend.pool.query("UPDATE ha_projection_meta SET artifact_index_version=1");
          assert.equal(await version(backend), 0, "previous caller cannot certify a merely requested job");
          await assert.rejects(backend.projection.readArtifactTimelinePage({ kind: "html", limit: 1 }), {
            code: "projection_pending",
          });
          assert.deepEqual(await backend.backfillReadIndexes(), { processed: 64, done: false });
          const cursor = await progress(backend);
          await backend.close();
          backend = await createPGliteStorageBackend({ repoId, storage });
          assert.deepEqual(await progress(backend), cursor, "restart resumes cleanup without consuming it");
          let turns = 1,
            units = 64,
            maxPageMs = 0;
          for (;;) {
            const pageStarted = performance.now(),
              page = await backend.backfillReadIndexes();
            maxPageMs = Math.max(maxPageMs, performance.now() - pageStarted);
            assert.ok(page.processed >= 0 && page.processed <= 64);
            units += page.processed;
            turns++;
            if (page.done) break;
            assert.ok(turns < Math.ceil((size * (readers + 2)) / 64) + 30);
          }
          assert.equal(
            units,
            size * (readers + 2) + 1,
            "clean old rows/count then build all/scoped reader rows exactly once",
          );
          const page = await backend.projection.readArtifactTimelinePage({ kind: "html", limit: 1 });
          assert.equal(page.rows.length, 1);
          assert.equal(page.counts.html, size);
          assert.deepEqual(await backend.backfillReadIndexes(), { processed: 0, done: true });
          t.diagnostic(`ARTIFACT_BACKGROUND ${JSON.stringify({ artifacts: size, readers, turns, units, maxPageMs })}`);
          await backend.close();
          backend = await createPGliteStorageBackend({ repoId, storage });
          assert.equal(await version(backend), 1);
          assert.deepEqual(await backend.backfillReadIndexes(), { processed: 0, done: true });
        } finally {
          await backend.close();
        }
      });
    });
  }
  test("reader fanout, rollback, restarts and writes in both phases preserve exact timelines", async (t) => {
    await withTempStoreAsync(async (root) => {
      const storage = { backend: "pglite" as const, dataDir: join(root, "db"), scope };
      let backend = await createPGliteStorageBackend({ repoId, storage });
      const write = (n: number, readers: string[], kind: "html" | "md" = "html") =>
        withPostgresTransaction(backend.pool, (client) => replaceArtifact(client, n, readers, kind), scope);
      try {
        await withPostgresTransaction(backend.pool, (client) => seedArtifactUpgrade(client, 3, 129), scope);
        await write(3, ["during-cleanup"], "md");
        for (let turns = 0; (await progress(backend))?.phase !== 2; turns++) {
          assert.ok(turns < 10);
          assert.ok((await backend.backfillReadIndexes()).processed <= 64);
        }
        await backend.pool.query(
          `ALTER TABLE ha_artifact_documents ADD CONSTRAINT reject_page CHECK(reader<>'reader-1')`,
        );
        await assert.rejects(backend.backfillReadIndexes(), { code: "23514" });
        assert.equal((await progress(backend)).cursor, null);
        assert.equal((await backend.pool.query("SELECT count(*)::int AS n FROM ha_artifact_documents")).rows[0]!.n, 0);
        await backend.pool.query("ALTER TABLE ha_artifact_documents DROP CONSTRAINT reject_page");
        assert.deepEqual(await backend.backfillReadIndexes(), { processed: 64, done: false });
        const partial = await progress(backend);
        assert.deepEqual(partial.cursor, { entity: artifactPath(1), offset: 64 });
        await backend.close();
        backend = await createPGliteStorageBackend({ repoId, storage });
        assert.deepEqual(await progress(backend), partial);
        await write(1, ["new-reader"], "md"); // Replaces a partly copied path with fewer readers.
        await withPostgresTransaction(
          backend.pool,
          async (client) => {
            await client.query("DELETE FROM ha_projection_values WHERE entity_id=$1", [artifactPath(2)]);
            await flushPgArtifactDocuments(client, scope, [artifactRetirementEntry(artifactPath(2))!]);
          },
          scope,
        );
        for (const n of [0, 4]) {
          await withPostgresTransaction(
            backend.pool,
            async (client) => {
              await client.query(
                `INSERT INTO ha_projection_values(tenant_id,project_id,policy_epoch,model,owner_id,entity_id,workspace_revision,value,readers)
              SELECT tenant_id,project_id,policy_epoch,model,owner_id,$1,workspace_revision,value,readers
              FROM ha_projection_values WHERE entity_id=$2`,
                [artifactPath(n), artifactPath(1)],
              );
              await replaceArtifact(client, n, [n === 0 ? "new-behind" : "new-above"], n === 0 ? "md" : "html");
            },
            scope,
          );
        }
        let turns = 0;
        for (;;) {
          const beforeRequest = await progress(backend);
          await backend.pool.query("SELECT ha_backfill_artifact_documents($1,$2,$3,$4)", [
            scope.tenantId,
            scope.projectId,
            scope.policyEpoch,
            repoId,
          ]);
          await backend.pool.query("UPDATE ha_projection_meta SET artifact_index_version=1");
          assert.equal(await version(backend), 0);
          assert.deepEqual(await progress(backend), beforeRequest, "previous callers preserve the live phase/cursor");
          await assert.rejects(backend.projection.readArtifactTimelinePage({ kind: "html", limit: 1 }), {
            code: "projection_pending",
          });
          const page = await backend.backfillReadIndexes();
          assert.ok(page.processed >= 0 && page.processed <= 64);
          if ((await version(backend)) === 1) break;
          assert.ok(++turns < 20);
        }
        const all = await backend.projection.readArtifactTimelinePage({ kind: "md", limit: 10 });
        assert.equal(all.rows.length, 3);
        assert.deepEqual(all.counts, { html: 1, md: 3, raw: 0 });
        for (const reader of ["new-reader", "during-cleanup", "reader-1"]) {
          const page = await withPostgresTransaction(
            backend.pool,
            (client) => readPgArtifactTimeline(client, { ...scope, readers: [reader] }, { kind: "md", limit: 10 }),
            scope,
          );
          assert.equal(page.rows.length, reader === "reader-1" ? 0 : 1);
          assert.equal(page.counts.md, reader === "reader-1" ? 0 : 1);
        }
        await write(3, ["after-complete"], "html");
        assert.deepEqual((await backend.projection.readArtifactTimelinePage({ kind: "html", limit: 10 })).counts, {
          html: 2,
          md: 2,
          raw: 0,
        });
        t.diagnostic(
          "ARTIFACT_INTERLEAVING rollback -> 64 reader rows -> restart exact offset -> replace/delete -> ready; counts exact",
        );
      } finally {
        await backend.close();
      }
    });
  });
});
