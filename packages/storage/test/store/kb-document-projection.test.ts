// harness-test-tier: fast
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import {
  KB_DOCUMENT_MODEL_VERSION,
  compileKbDocumentUpserted,
} from "@harness-anything/kernel/internal/domain/kb-document-event.ts";
import { makeTaskEventStore } from "../../src/store/task-event-store.ts";
import { makeTaskProjection } from "../../src/projection/rebuildable-task-projection.ts";
import { withTempStore } from "./helpers.ts";

const occurredAt = "2026-11-27T01:00:00.000Z";
const actor = { principal: { personId: "person_alice" }, executor: null } as const;

test("SQLite KB projection folds bundles, stores content blobs, filters status/domain/tag, paginates, and refolds", () => {
  withTempStore((rootDir) => {
    const store = makeTaskEventStore({ rootDir, repoId: "kb-proj" });
    const projection = makeTaskProjection({ rootDir, eventStore: store });
    try {
      const pdfBytes = new Uint8Array([0x25, 0x50, 0x44, 0x46]);
      const assetBytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47]);
      const bundles = [
        compileKbDocumentUpserted({
          eventId: "event-kb-1",
          opId: "op_kb_1",
          workspaceRevision: 1,
          actor,
          source: "local",
          occurredAt,
          docId: "doc_alpha",
          documentRevision: 1,
          manifest: {
            title: "Alpha Architecture",
            aliases: ["alpha"],
            summary: "Alpha active specification.",
            domain: "architecture",
            tags: ["core", "s1"],
            status: "active",
            relations: [],
          },
          viewMarkdown: "# Alpha\n\n## Design\n\nAlpha body.\n",
          sourceFilename: "source.pdf",
          sourceMediaType: "application/pdf",
          sourceBytes: pdfBytes,
          assets: [{ path: "assets/diagram.png", mediaType: "image/png", body: assetBytes, page: 1 }],
        }),
        compileKbDocumentUpserted({
          eventId: "event-kb-2",
          opId: "op_kb_2",
          workspaceRevision: 2,
          actor,
          source: "local",
          occurredAt,
          docId: "doc_beta",
          documentRevision: 1,
          manifest: {
            title: "Beta Legacy Guide",
            aliases: [],
            summary: "Superseded guide.",
            domain: "architecture",
            tags: ["legacy"],
            status: "superseded",
            supersededBy: "doc_alpha",
            relations: [{ type: "supersedes", target: "doc_alpha" }],
          },
          viewMarkdown: "# Beta\n\nOld guide.\n",
        }),
        compileKbDocumentUpserted({
          eventId: "event-kb-3",
          opId: "op_kb_3",
          workspaceRevision: 3,
          actor,
          source: "local",
          occurredAt,
          docId: "doc_gamma",
          documentRevision: 1,
          manifest: {
            title: "Gamma Rejected Proposal",
            aliases: [],
            summary: "Rejected draft.",
            domain: "ops",
            tags: ["core"],
            status: "rejected",
            relations: [],
          },
          viewMarkdown: "# Gamma\n\nRejected draft.\n",
        }),
        compileKbDocumentUpserted({
          eventId: "event-kb-4",
          opId: "op_kb_4",
          workspaceRevision: 4,
          actor,
          source: "local",
          occurredAt,
          docId: "doc_delta",
          documentRevision: 1,
          manifest: {
            title: "Delta Runbook",
            aliases: [],
            summary: "Active ops runbook.",
            domain: "ops",
            tags: ["core", "runbook"],
            status: "active",
            relations: [],
          },
          viewMarkdown: "# Delta\n\n## Steps\n\nRun checks.\n",
        }),
      ];

      for (const bundle of bundles) {
        store.append(bundle);
        projection.apply(bundle.event, bundle.plan);
      }

      // Verify content-addressed blobs are persisted and readable.
      const byId = projection.readKbDocuments({ by: "id", docId: "doc_alpha" });
      assert.equal(byId.status, "ready");
      if (byId.status === "ready") {
        assert.equal(byId.records.length, 1);
        const rec = byId.records[0]!;
        assert.equal(
          new TextDecoder().decode(store.readContentBlob(rec.view.sha256)!),
          "# Alpha\n\n## Design\n\nAlpha body.\n",
        );
        assert.deepEqual(Uint8Array.from(store.readContentBlob(rec.source.sha256)!), pdfBytes);
        assert.deepEqual(Uint8Array.from(store.readContentBlob(rec.assets[0]!.sha256)!), assetBytes);
      }

      // Default list hides superseded & rejected documents.
      const defaultList = projection.readKbDocuments({ by: "list" });
      assert.equal(defaultList.status, "ready");
      if (defaultList.status === "ready") {
        assert.deepEqual(
          defaultList.records.map((r) => r.docId),
          ["doc_alpha", "doc_delta"],
        );
      }

      // includeArchived surfaces superseded & rejected documents.
      const withArchived = projection.readKbDocuments({ by: "list", includeArchived: true });
      assert.equal(withArchived.status, "ready");
      if (withArchived.status === "ready") {
        assert.deepEqual(
          withArchived.records.map((r) => r.docId),
          ["doc_alpha", "doc_beta", "doc_delta", "doc_gamma"],
        );
      }

      // Domain & tag filters + cursor pagination.
      const page1 = projection.readKbDocuments({ by: "list", tag: "core", limit: 1 });
      assert.equal(page1.status, "ready");
      if (page1.status === "ready") {
        assert.deepEqual(
          page1.records.map((r) => r.docId),
          ["doc_alpha"],
        );
        assert.equal(page1.nextCursor, "doc_alpha");
        const page2 = projection.readKbDocuments({ by: "list", tag: "core", limit: 1, cursor: page1.nextCursor! });
        assert.equal(page2.status, "ready");
        if (page2.status === "ready") {
          assert.deepEqual(
            page2.records.map((r) => r.docId),
            ["doc_delta"],
          );
          assert.equal(page2.nextCursor, null);
        }
      }
    } finally {
      projection.close();
    }

    // Simulate stale model version and verify automatic refold from canonical events.
    const db = new DatabaseSync(projection.path);
    try {
      db.exec("DELETE FROM kb_document");
      db.exec(`UPDATE kb_document_cursor SET model_version = ${KB_DOCUMENT_MODEL_VERSION - 1}`);
    } finally {
      db.close();
    }
    const reopened = makeTaskProjection({ rootDir, eventStore: store });
    try {
      const recovered = reopened.readKbDocuments({ by: "list", includeArchived: true });
      assert.equal(recovered.status, "ready");
      if (recovered.status === "ready") {
        assert.deepEqual(
          recovered.records.map((r) => r.docId),
          ["doc_alpha", "doc_beta", "doc_delta", "doc_gamma"],
        );
      }
    } finally {
      reopened.close();
    }
  });
});
