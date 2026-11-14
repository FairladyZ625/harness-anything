// harness-test-tier: integration
import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { applyEvent } from "../../src/projection/rebuildable-task-projection-event-application.ts";
import { makeTaskProjection, makeTaskEventStore } from "../../src/index.ts";
import { withTempStoreAsync } from "./helpers.ts";
import { initRepo } from "./task-event-store.fixtures.ts";
import { archivedFactUpgradeHistory, assertTerminalMaterialization } from "../terminal-materialization.fixture.ts";

test("SQLite terminal documents retain canonical holds and unlock incrementally", async () => {
  await withTempStoreAsync(async (rootDir) => {
    initRepo(rootDir);
    const store = makeTaskEventStore({ repoId: "terminal-materialization", rootDir }),
      projection = makeTaskProjection({ rootDir, eventStore: store });
    try {
      await assertTerminalMaterialization({
        append: (bundle) => {
          store.append(bundle);
          projection.apply(bundle.event, bundle.plan);
        },
        replayAcceptedDocument: (bundle) => {
          const db = new DatabaseSync(projection.path),
            event = bundle.event,
            readBlob = (sha256: string) => {
              const blob = bundle.blobs.find((entry) => entry.sha256 === sha256);
              return blob ? Buffer.from(blob.body) : store.readContentBlob(sha256);
            };
          try {
            db.exec("BEGIN");
            if (event.schema === "doc-event/v1") {
              const invalid = {
                ...event,
                payload: {
                  ...event.payload,
                  changes: event.payload.changes.map((change) => ({ ...change, baseBlobSha256: "0".repeat(64) })),
                },
              };
              assert.throws(
                () => applyEvent(db, invalid, JSON.stringify(invalid), readBlob),
                /document base mismatch/u,
              );
              db.exec("ROLLBACK; BEGIN");
            }
            applyEvent(db, event, JSON.stringify(event), readBlob);
            db.exec("COMMIT");
          } finally {
            db.close();
          }
        },
        document: (path) => projection.readDocument(path).document,
        history: (path) => projection.readDocumentHistory(path).document,
        fact: (id) => projection.readFact(id).fact,
        decision: (id) => projection.readDecision(id).decision,
      });
    } finally {
      await store.drain();
      projection.close();
    }
  });
});

test("SQLite schema-38 archived Facts survive warm upgrade and match cold history", async () => {
  await withTempStoreAsync(async (rootDir) => {
    initRepo(rootDir);
    const store = makeTaskEventStore({ repoId: "archived-fact-upgrade", rootDir });
    let projection = makeTaskProjection({ rootDir, eventStore: store });
    try {
      for (const bundle of archivedFactUpgradeHistory()) {
        store.append(bundle);
        projection.apply(bundle.event, bundle.plan);
      }
      const paths = ["facts/F-00000010.md", "facts/F-00000011.md"],
        expected = paths.map((path) => projection.readDocumentHistory(path).document),
        projectionPath = projection.path;
      projection.close();
      const db = new DatabaseSync(projectionPath);
      try {
        // Frozen pre-upgrade archive effect: no active or historical descriptor, same v38 cache.
        db.exec(
          "DELETE FROM document_history; DELETE FROM projection_maintenance WHERE key LIKE 'terminal-materialization%'",
        );
      } finally {
        db.close();
      }
      const unavailable = expected[0]!.blobSha256;
      assert.throws(
        () =>
          makeTaskProjection({
            rootDir,
            eventStore: {
              ...store,
              readContentBlob: (sha256) => (sha256 === unavailable ? null : store.readContentBlob(sha256)),
            },
          }),
        /projection document blob .* is unavailable/u,
      );
      const interrupted = new DatabaseSync(projectionPath);
      try {
        assert.equal(
          interrupted.prepare("SELECT COUNT(*) AS n FROM document_history").get()!.n,
          0,
          "partial recovery rolls back",
        );
        assert.equal(
          interrupted
            .prepare("SELECT COUNT(*) AS n FROM projection_maintenance WHERE key='terminal-materialization-history-v1'")
            .get()!.n,
          0,
          "failed recovery never commits its marker",
        );
      } finally {
        interrupted.close();
      }
      projection = makeTaskProjection({ rootDir, eventStore: store });
      assert.deepEqual(
        paths.map((path) => projection.readDocumentHistory(path).document),
        expected,
      );
      assert.ok(paths.every((path) => projection.readDocument(path).document === null));
      projection.close();
      projection = makeTaskProjection({ rootDir, eventStore: store });
      assert.deepEqual(
        paths.map((path) => projection.readDocumentHistory(path).document),
        expected,
        "reopen is idempotent",
      );
      projection.rebuild();
      assert.deepEqual(
        paths.map((path) => projection.readDocumentHistory(path).document),
        expected,
        "warm and cold histories agree",
      );
    } finally {
      await store.drain();
      projection.close();
    }
  });
});
