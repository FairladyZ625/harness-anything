// harness-test-tier: integration
import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { applyEvent } from "../../src/projection/rebuildable-task-projection-event-application.ts";
import { makeTaskProjection, makeTaskEventStore } from "../../src/index.ts";
import { withTempStoreAsync } from "./helpers.ts";
import { initRepo } from "./task-event-store.fixtures.ts";
import { assertTerminalMaterialization } from "../terminal-materialization.fixture.ts";

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
