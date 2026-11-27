// harness-test-tier: contract
import assert from "node:assert/strict";
import { join } from "node:path";
import test from "node:test";
import { compileKbDocumentUpserted } from "@harness-anything/kernel/internal/domain/kb-document-event.ts";
import { createPGliteStorageBackend } from "../../src/pglite/storage-backend.ts";
import { makeTaskEventStore } from "../../src/store/task-event-store.ts";
import { makeTaskProjection } from "../../src/projection/rebuildable-task-projection.ts";
import { withTempStoreAsync } from "../store/helpers.ts";
import { pgliteIntegrationSuite } from "./pglite-runtime.fixture.ts";

const occurredAt = "2026-11-27T02:00:00.000Z";
const actor = { principal: { personId: "person_alice" }, executor: null } as const;

pgliteIntegrationSuite("PGlite KB document projection parity", () => {
  test("PGlite matches SQLite parity across filters/pagination and backfills stale kb_document_version", async () => {
    await withTempStoreAsync(async (rootDir) => {
      const repoId = "pglite-kb",
        storage = {
          backend: "pglite" as const,
          dataDir: join(rootDir, "database"),
          scope: { tenantId: "t", projectId: "p", policyEpoch: 1 },
        };

      const bundles = [
        compileKbDocumentUpserted({
          eventId: "event-pg-kb-1",
          opId: "op_pg_kb_1",
          workspaceRevision: 1,
          actor,
          source: "local",
          occurredAt,
          docId: "doc_pg_01",
          documentRevision: 1,
          manifest: {
            title: "PG Spec One",
            aliases: ["pg-1"],
            summary: "First shared document.",
            domain: "architecture",
            tags: ["parity", "s1"],
            status: "active",
            relations: [],
          },
          viewMarkdown: "# PG Spec One\n\n## Section A\n\nBody A.\n",
        }),
        compileKbDocumentUpserted({
          eventId: "event-pg-kb-2",
          opId: "op_pg_kb_2",
          workspaceRevision: 2,
          actor,
          source: "local",
          occurredAt,
          docId: "doc_pg_02",
          documentRevision: 1,
          manifest: {
            title: "PG Spec Two (Superseded)",
            aliases: [],
            summary: "Superseded doc.",
            domain: "architecture",
            tags: ["parity"],
            status: "superseded",
            supersededBy: "doc_pg_01",
            relations: [],
          },
          viewMarkdown: "# PG Spec Two\n\nOld.\n",
        }),
        compileKbDocumentUpserted({
          eventId: "event-pg-kb-3",
          opId: "op_pg_kb_3",
          workspaceRevision: 3,
          actor,
          source: "local",
          occurredAt,
          docId: "doc_pg_03",
          documentRevision: 1,
          manifest: {
            title: "PG Spec Three",
            aliases: [],
            summary: "Active ops doc.",
            domain: "ops",
            tags: ["parity"],
            status: "active",
            relations: [],
          },
          viewMarkdown: "# PG Spec Three\n\nOps.\n",
        }),
      ];

      const sqliteRoot = join(rootDir, "sqlite-parity");
      const sqliteStore = makeTaskEventStore({ rootDir: sqliteRoot, repoId });
      const sqliteProj = makeTaskProjection({ rootDir: sqliteRoot, eventStore: sqliteStore });
      const pgStore = makeTaskEventStore({ rootDir, repoId, storage });
      const pgProj = makeTaskProjection({ rootDir, eventStore: pgStore, repoId, storage });
      try {
        for (const bundle of bundles) {
          sqliteStore.append(bundle);
          sqliteProj.apply(bundle.event, bundle.plan);
          pgStore.append(bundle);
        }

        for (const query of [
          { by: "id" as const, docId: "doc_pg_01" },
          { by: "list" as const },
          { by: "list" as const, includeArchived: true },
          { by: "list" as const, domain: "ops" },
          { by: "list" as const, tag: "parity", limit: 1 },
          { by: "list" as const, tag: "parity", limit: 1, cursor: "doc_pg_01" },
        ]) {
          assert.deepEqual(pgProj.readKbDocuments(query), sqliteProj.readKbDocuments(query));
        }
      } finally {
        sqliteProj.close();
        await sqliteStore.drain();
        pgProj.close();
        await pgStore.drain();
      }

      // Simulate stale kb_document_version and verify pending -> automatic backfill on reopen.
      const backend = await createPGliteStorageBackend({ repoId, storage });
      try {
        await backend.pool.query("DELETE FROM ha_projection_values WHERE model = 'kb-document'");
        await backend.pool.query("UPDATE ha_projection_meta SET kb_document_version = 0");
        assert.equal((await backend.projection.readKbDocuments({ by: "id", docId: "doc_pg_01" })).status, "pending");
      } finally {
        await backend.close();
      }

      const reopenedStore = makeTaskEventStore({ rootDir, repoId, storage });
      const reopenedProj = makeTaskProjection({ rootDir, eventStore: reopenedStore, repoId, storage });
      try {
        const backfilled = reopenedProj.readKbDocuments({ by: "list", includeArchived: true });
        assert.equal(backfilled.status, "ready");
        if (backfilled.status === "ready") {
          assert.deepEqual(
            backfilled.records.map((r) => r.docId),
            ["doc_pg_01", "doc_pg_02", "doc_pg_03"],
          );
        }
      } finally {
        reopenedProj.close();
        await reopenedStore.drain();
      }
    });
  });
});
