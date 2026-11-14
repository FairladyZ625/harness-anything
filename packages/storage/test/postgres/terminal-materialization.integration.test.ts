// harness-test-tier: integration
import test from "node:test";
import assert from "node:assert/strict";
import type { DocumentState } from "@harness-anything/kernel/internal/domain/doc-sync.contract.ts";
import { getPgProjectionValue } from "../../src/pg/pg-projection-values.ts";
import { withPostgresTransaction } from "../../src/postgres/transaction.ts";
import { materializePgProjectionEvent, rebuildPgProjection } from "../../src/pg/pg-task-event-materialize.ts";
import { createPgStorageBackend } from "../../src/pg/backend.ts";
import { pgRuntimeFixture } from "./pg-runtime.fixture.ts";
import { archivedFactUpgradeHistory, assertTerminalMaterialization } from "../terminal-materialization.fixture.ts";
import { initializePgTerminalMaterialization } from "../../src/pg/pg-query-model-materialize.ts";

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
      // Historical replay advances A3 beyond this fixture's accepting store. Inspect its rows
      // directly; public reads correctly refuse a projection cut ahead of the canonical ledger.
      document: (path) =>
        withPostgresTransaction(
          fixture.pool,
          (client) => getPgProjectionValue<DocumentState>(client, scope, "document", path),
          scope,
        ),
      history: (path) =>
        withPostgresTransaction(
          fixture.pool,
          (client) => getPgProjectionValue<DocumentState>(client, scope, "document-history", path),
          scope,
        ),
      fact: async (id) => (await backend.projection.readFact(id)).fact,
      decision: async (id) => (await backend.projection.readDecision(id)).decision,
    });
  } finally {
    await fixture.pool.end();
    await fixture.close();
  }
});

test("PostgreSQL archived Facts survive warm upgrade and preserve cold history", async () => {
  const fixture = await pgRuntimeFixture(),
    scope = { tenantId: "warm", projectId: "history", policyEpoch: 0, readers: [] },
    repoId = "archived-fact-upgrade",
    backend = createPgStorageBackend({ pool: fixture.pool, repoId, scope }),
    paths = ["facts/F-00000010.md", "facts/F-00000011.md"];
  try {
    let revision = 0;
    for (const bundle of archivedFactUpgradeHistory()) {
      await backend.eventStore.append(bundle, revision, { repoId, holderId: "fixture", epoch: 1 });
      revision++;
    }
    const history = () =>
        Promise.all(paths.map((path) => backend.projection.readDocumentHistory(path).then((read) => read.document))),
      expected = await history();
    await withPostgresTransaction(
      fixture.pool,
      async (client) => {
        await client.query(
          "DELETE FROM ha_projection_values WHERE tenant_id=$1 AND project_id=$2 AND model IN ('document-history','materialization-index')",
          [scope.tenantId, scope.projectId],
        );
      },
      scope,
    );
    await assert.rejects(
      withPostgresTransaction(
        fixture.pool,
        async (client) => {
          await client.query("DELETE FROM ha_content_blobs WHERE tenant_id=$1 AND project_id=$2 AND sha256=$3", [
            scope.tenantId,
            scope.projectId,
            expected[1]!.blobSha256,
          ]);
          await initializePgTerminalMaterialization(client, scope, revision);
        },
        scope,
      ),
      /projection document blob .* is unavailable/u,
    );
    await withPostgresTransaction(
      fixture.pool,
      async (client) => {
        const partial = await client.query(
          "SELECT 1 FROM ha_projection_values WHERE tenant_id=$1 AND project_id=$2 AND model='document-history'",
          [scope.tenantId, scope.projectId],
        );
        assert.equal(partial.rows.length, 0, "partial recovery rolls back");
        assert.equal(
          await getPgProjectionValue(client, scope, "materialization-index", "history-v1"),
          null,
          "failed recovery never commits its marker",
        );
        await initializePgTerminalMaterialization(client, scope, revision);
      },
      scope,
    );
    assert.deepEqual(await history(), expected);
    await withPostgresTransaction(
      fixture.pool,
      (client) => initializePgTerminalMaterialization(client, scope, revision),
      scope,
    );
    assert.deepEqual(await history(), expected, "upgrade is idempotent");
    assert.ok(
      (await Promise.all(paths.map((path) => backend.projection.readDocument(path)))).every(
        (read) => read.document === null,
      ),
    );
    await withPostgresTransaction(
      fixture.pool,
      (client) =>
        rebuildPgProjection(client, scope, {
          events: archivedFactUpgradeHistory().map(({ event }) => event),
          sourceRevision: revision,
          readContentBlob: async (sha256) =>
            (
              await client.query<{ body: Buffer }>(
                "SELECT body FROM ha_content_blobs WHERE tenant_id=$1 AND project_id=$2 AND sha256=$3",
                [scope.tenantId, scope.projectId, sha256],
              )
            ).rows[0]?.body ?? null,
        }),
      scope,
    );
    assert.deepEqual(await history(), expected, "warm and cold histories agree");
  } finally {
    await fixture.pool.end();
    await fixture.close();
  }
});
