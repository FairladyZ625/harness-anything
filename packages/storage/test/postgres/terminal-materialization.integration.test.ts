// harness-test-tier: integration
import test from "node:test";
import { withPostgresTransaction } from "../../src/postgres/transaction.ts";
import { materializePgProjectionEvent } from "../../src/pg/pg-task-event-materialize.ts";
import { createPgStorageBackend } from "../../src/pg/backend.ts";
import { pgRuntimeFixture } from "./pg-runtime.fixture.ts";
import { assertTerminalMaterialization } from "../terminal-materialization.fixture.ts";

test("PostgreSQL terminal documents retain canonical holds and unlock incrementally", async () => {
  const fixture = await pgRuntimeFixture(),
    repoId = "terminal-materialization",
    scope = { tenantId: "terminal", projectId: "materialization", policyEpoch: 0, readers: [] },
    backend = createPgStorageBackend({
      pool: fixture.pool,
      repoId,
      scope,
    });
  let revision = 0;
  try {
    await assertTerminalMaterialization({
      append: async (bundle) => {
        await backend.eventStore.append(bundle, revision, { repoId, holderId: "fixture", epoch: 1 });
        revision++;
      },
      replayAcceptedDocument: (bundle) =>
        withPostgresTransaction(
          fixture.pool,
          (client) =>
            materializePgProjectionEvent(client, scope, {
              event: bundle.event,
              readContentBlob: (sha256) => {
                const blob = bundle.blobs.find((entry) => entry.sha256 === sha256);
                return blob ? Buffer.from(blob.body) : null;
              },
            }),
          scope,
        ),
      document: async (path) => (await backend.projection.readDocument(path)).document,
      history: async (path) => (await backend.projection.readDocumentHistory(path)).document,
      fact: async (id) => (await backend.projection.readFact(id)).fact,
      decision: async (id) => (await backend.projection.readDecision(id)).decision,
    });
  } finally {
    await fixture.pool.end();
    await fixture.close();
  }
});
