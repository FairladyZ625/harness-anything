// harness-test-tier: integration
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { createPGliteStorageBackend } from "../../src/pglite/storage-backend.ts";
import { backfillPgReadIndexPage } from "../../src/pg/pg-read-index-backfill.ts";
import { withPostgresTransaction } from "../../src/postgres/transaction.ts";
import { v5PutDocument } from "../postgres/pg-v5-document-client.fixture.ts";
import { pgliteIntegrationSuite } from "./pglite-runtime.fixture.ts";

pgliteIntegrationSuite("PGlite v5 document metadata upgrade", () => {
  test("reopen exposes legacy documents immediately and resumes bounded metadata pages", async () => {
    const dataDir = mkdtempSync(path.join(tmpdir(), "ha-pglite-v5-")),
      scope = { tenantId: "pglite-upgrade", projectId: "pglite-upgrade", policyEpoch: 0, readers: [] },
      input = { repoId: "pglite-upgrade", storage: { backend: "pglite", dataDir, scope } } as const;
    let backend = await createPGliteStorageBackend(input);
    try {
      await backend.db.exec(
        "DROP TRIGGER ha_document_metadata_previous_writer ON ha_projection_values; ALTER TABLE ha_projection_values DROP COLUMN document_metadata",
      );
      await withPostgresTransaction(
        backend.pool,
        async (client) => {
          await client.query(
            "INSERT INTO ha_projection_meta (tenant_id,project_id,policy_epoch,schema_version) VALUES ($1,$2,$3,5)",
            [scope.tenantId, scope.projectId, scope.policyEpoch],
          );
          for (let id = 0; id < 130; id++)
            await v5PutDocument(client, scope, {
              path: `docs/${id}.md`,
              body: "previous\u0000 bytes\ud800",
              blobSha256: `sha256:${id}`,
              size: 20,
              mediaType: "text/markdown",
              policyId: "document/v1",
              workspaceRevision: 0,
            });
        },
        scope,
      );
      await backend.close();
      backend = await createPGliteStorageBackend(input);
      const pending = async () =>
        Number(
          (
            await backend.db.query<{ count: string }>(
              "SELECT count(*) FROM ha_projection_values WHERE model='document' AND document_metadata IS NULL",
            )
          ).rows[0]!.count,
        );
      assert.equal(await pending(), 130, "open must not run historical backfill");
      assert.equal((await backend.projection.readDocuments("")).documents.length, 130);
      assert.deepEqual(await backfillPgReadIndexPage(backend.pool, scope, input.repoId), {
        processed: 64,
        done: false,
      });
      assert.equal(await pending(), 66);
      await backend.close();
      backend = await createPGliteStorageBackend(input);
      assert.equal(await pending(), 66, "reopen retains committed progress");
      let processed = 64;
      for (;;) {
        const page = await backfillPgReadIndexPage(backend.pool, scope, input.repoId);
        processed += page.processed;
        if (page.done) break;
      }
      assert.equal(processed, 260, "130 metadata rows plus 130 non-artifact document visits in the shared queue");
      assert.equal(
        (await backend.pool.query("SELECT artifact_index_version FROM ha_projection_meta")).rows[0]!
          .artifact_index_version,
        1,
      );
      assert.equal(await pending(), 0);

      assert.equal((await backend.projection.readDocument("docs/0.md")).document!.body, "previous\u0000 bytes\ud800");
      assert.equal(
        (await backend.db.query<{ schema_version: number }>("SELECT schema_version FROM ha_projection_meta")).rows[0]!
          .schema_version,
        5,
      );
    } finally {
      await backend.close();
      rmSync(dataDir, { recursive: true, force: true });
    }
  });
});
