// harness-test-tier: integration
import assert from "node:assert/strict";
import test from "node:test";
import { pgRuntimeFixture } from "./pg-runtime.fixture.ts";
import { withPostgresTransaction } from "../../src/postgres/transaction.ts";
import { backfillPgReadIndexPage } from "../../src/pg/pg-read-index-backfill.ts";
import { createPgStorageBackend } from "../../src/pg/backend.ts";
import { ensurePgProjectionSchema } from "../../src/pg/pg-projection-schema.ts";
import {
  artifactScope as scope,
  artifactRepo as repoId,
  artifactPath,
  seedArtifactUpgrade,
  replaceArtifact,
} from "./pg-artifact-online.fixture.ts";

test("native PostgreSQL keeps artifact upgrade pending while the runtime writer advances bounded pages", async (t) => {
  const fixture = await pgRuntimeFixture(),
    backend = createPgStorageBackend({ pool: fixture.pool, repoId, scope }),
    manage = <T>(operation: Parameters<typeof withPostgresTransaction<T>>[1]) =>
      withPostgresTransaction(fixture.adminPool, operation, scope);
  try {
    await manage((client) => seedArtifactUpgrade(client, 130, 3));
    // Re-running the schema release must not consume the upgrade before handing off to readers.
    const owner = await fixture.adminPool.connect();
    try {
      await ensurePgProjectionSchema(owner);
    } finally {
      owner.release();
    }
    await assert.rejects(backend.projection.readArtifactTimelinePage({ kind: "html", limit: 1 }), {
      code: "projection_pending",
    });
    assert.equal((await backend.projection.readDocumentMetadata(artifactPath(130))).document?.workspaceRevision, 130);
    // Unlike the embedded cold open, this fixture has not certified the repo's empty summary remainder.
    assert.deepEqual(await backfillPgReadIndexPage(fixture.pool, scope, repoId), { processed: 0, done: false });
    assert.deepEqual((await manage((client) => client.query("SELECT ready FROM ha_event_summary_state"))).rows, [
      { ready: true },
    ]);
    const first = await backfillPgReadIndexPage(fixture.pool, scope, repoId);
    assert.deepEqual(first, { processed: 64, done: false });
    const cursor = (await manage((client) => client.query("SELECT cursor FROM ha_artifact_backfill"))).rows[0]!.cursor;
    await manage((client) => replaceArtifact(client, 130, ["during-cleanup"], "md"));
    let units = 64,
      turns = 2;
    for (;;) {
      const page = await backfillPgReadIndexPage(fixture.pool, scope, repoId);
      assert.ok(page.processed >= 0 && page.processed <= 64);
      units += page.processed;
      turns++;
      if (page.done) break;
      assert.ok(turns < 30);
    }
    assert.equal(units, 649, "130 dirty rows + 1 dirty count + 129 x 4 reader rows + 2 replacement rows");
    const result = await backend.projection.readArtifactTimelinePage({ kind: "html", limit: 1 });
    assert.equal(result.rows.length, 1);
    assert.deepEqual(result.counts, { html: 129, md: 1, raw: 0 });
    assert.deepEqual(await backfillPgReadIndexPage(fixture.pool, scope, repoId), { processed: 0, done: true });
    assert.equal(
      (await manage((client) => client.query("SELECT count(*)::int AS n FROM ha_artifact_backfill"))).rows[0]!.n,
      0,
    );
    t.diagnostic(`PG_ARTIFACT_BACKGROUND ${JSON.stringify({ turns, units, cursor, counts: result.counts })}`);
  } finally {
    await fixture.pool.end();
    await fixture.close();
  }
});
