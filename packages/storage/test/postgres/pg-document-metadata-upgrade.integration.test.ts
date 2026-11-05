// harness-test-tier: integration
import assert from "node:assert/strict";
import test from "node:test";
import {
  createPgTaskProjectionSource,
  ensurePgProjectionSchema,
  materializePgProjectionEvents,
} from "../../src/pg/index.ts";
import { putPgProjectionValue, deletePgProjectionValue } from "../../src/pg/pg-projection-values.ts";
import { withPostgresTransaction } from "../../src/postgres/transaction.ts";
import { POSTGRES_SCOPE_SCHEMA_CONTRACT } from "../../src/postgres/scope-schema.ts";
import { pgRuntimeFixture } from "./pg-runtime.fixture.ts";
import { v5Documents, v5PutDocument } from "./pg-v5-document-client.fixture.ts";

test("populated v5 upgrades online with bounded backfill and previous/current readers and writers", async (t) => {
  const fixture = await pgRuntimeFixture(),
    scope = { tenantId: "tenant-upgrade", projectId: "project-upgrade", policyEpoch: 1, readers: ["reader-a"] },
    document = (
      id: string,
      revision = 1,
      body = 'old\u0000 body with \\"body\\":\\"not a field\\", and surrogate \ud800',
    ) => ({
      path: `docs/${id}.md`,
      blobSha256: `sha256:${id}-${revision}`,
      body,
      size: Buffer.byteLength(body),
      mediaType: "text/markdown",
      policyId: "document/v1",
      workspaceRevision: revision,
    }),
    transaction = <T>(operation: (client: import("pg").PoolClient) => Promise<T>) =>
      withPostgresTransaction(fixture.pool, operation, scope),
    backfill = (afterOwner = "", afterEntity = "") =>
      transaction(
        async (client) =>
          (
            await client.query<{ processed: number; next_owner: string; next_entity: string }>(
              "SELECT * FROM ha_backfill_document_metadata($1,$2,$3,$4,$5)",
              [scope.tenantId, scope.projectId, scope.policyEpoch, afterOwner, afterEntity],
            )
          ).rows[0]!,
      ),
    pending = () =>
      transaction(async (client) =>
        Number(
          (
            await client.query<{ count: string }>(
              "SELECT count(*) FROM ha_projection_values WHERE model='document' AND document_metadata IS NULL",
            )
          ).rows[0]!.count,
        ),
      ),
    source = createPgTaskProjectionSource({ pool: fixture.pool, repoId: "upgrade", scope });
  try {
    // Recreate the actual previous layout, not a cold rebuild in the new generation.
    await fixture.adminPool.query(
      "DROP TRIGGER IF EXISTS ha_document_metadata_previous_writer ON ha_projection_values",
    );
    await fixture.adminPool.query("ALTER TABLE ha_projection_values DROP COLUMN IF EXISTS document_metadata");
    await transaction(async (client) => {
      await client.query(
        `INSERT INTO ha_projection_meta (tenant_id,project_id,policy_epoch,readers,schema_version)
        VALUES ($1,$2,$3,$4::text[],5)`,
        [scope.tenantId, scope.projectId, scope.policyEpoch, scope.readers],
      );
      for (let index = 0; index < 130; index++)
        await v5PutDocument(client, scope, document(String(index).padStart(3, "0")));
    });
    assert.deepEqual(await source.readCut(), { status: "ready", watermark: 0, sourceRevision: 0 });
    assert.equal((await transaction((client) => v5Documents(client, scope))).length, 130);

    // Schema owner expands first. No rewrite/backfill or projection-generation switch in this transaction.
    const admin = await fixture.adminPool.connect();
    try {
      await admin.query(`SET ROLE "${POSTGRES_SCOPE_SCHEMA_CONTRACT.roles.schemaOwner}"`);
      await ensurePgProjectionSchema(admin, { indexBuild: "isolated" });
    } finally {
      await admin.query("RESET ROLE");
      admin.release();
    }
    assert.equal(await pending(), 130);
    assert.equal((await source.readDocuments("docs/")).documents.length, 130, "legacy metadata remains readable");
    assert.equal((await transaction((client) => v5Documents(client, scope))).length, 130);
    await transaction((client) => materializePgProjectionEvents(client, scope, { revision: 0, events: [] }));
    const first = await backfill();
    assert.equal(first.processed, 64);
    assert.equal(await pending(), 66);

    // Rollback of one batch leaves the previous committed cut usable; resume starts at NULL rows.
    const interrupted = new Error("interrupted migration batch");
    await assert.rejects(
      transaction(async (client) => {
        await client.query("SELECT * FROM ha_backfill_document_metadata($1,$2,$3,$4,$5)", [
          scope.tenantId,
          scope.projectId,
          scope.policyEpoch,
          first.next_owner,
          first.next_entity,
        ]);
        throw interrupted;
      }),
      (error) => error === interrupted,
    );
    assert.equal(await pending(), 66);
    const large = document("large", 2, "LARGE_BODY_SENTINEL".repeat(2 ** 21)),
      current = document("current", 2);
    await Promise.all([
      transaction(async (client) => {
        await v5PutDocument(client, scope, document("000", 3, "previous update after backfill\u0000"));
        await v5PutDocument(client, scope, document("129", 3, "previous update before backfill"));
        await v5PutDocument(client, scope, document("001-previous-insert", 3, "insert behind cursor"));
        await v5PutDocument(client, scope, large);
        await client.query("DELETE FROM ha_projection_values WHERE model='document' AND entity_id='docs/128.md'");
      }),
      transaction((client) => putPgProjectionValue(client, scope, "document", current.path, "", 2, current)),
    ]);
    assert.equal((await source.readDocuments("")).documents.length, 132, "mixed old/current writes remain readable");
    const batches: number[] = [];
    let cursor = first;
    for (;;) {
      const batch = await backfill(cursor.next_owner, cursor.next_entity);
      batches.push(batch.processed);
      assert.ok(batch.processed >= 0 && batch.processed <= 64);
      if (batch.processed === 0) break;
      cursor = batch;
    }
    assert.equal(await pending(), 0);
    const previous = await transaction((client) => v5Documents(client, scope)),
      parse = JSON.parse;
    JSON.parse = (value, reviver) => {
      assert.ok(!value.includes("LARGE_BODY_SENTINEL"), "metadata reads must not parse document bodies");
      return parse(value, reviver);
    };
    try {
      const listed = (await source.readDocuments("")).documents;
      assert.deepEqual(
        listed.map(({ path }) => path),
        previous.map(({ path }) => path),
      );
      assert.equal(listed.find(({ path }) => path === large.path)!.size, large.size);
      assert.equal(
        listed.find(({ path }) => path === "docs/128.md"),
        undefined,
      );
      assert.equal((await source.readDocumentMetadata(large.path)).document!.workspaceRevision, 2);
      const hidden = createPgTaskProjectionSource({
        pool: fixture.pool,
        repoId: "upgrade",
        scope: { ...scope, readers: ["reader-b"] },
      });
      assert.deepEqual((await hidden.readDocuments("")).documents, []);
      assert.equal((await source.readReplicaBasis(null)).documents.length, previous.length);
    } finally {
      JSON.parse = parse;
    }
    assert.equal((await source.readDocument(large.path)).document!.body, large.body);
    assert.equal(previous.find(({ path }) => path === "docs/000.md")!.body, "previous update after backfill\u0000");
    await transaction((client) => v5PutDocument(client, scope, document("000", 1, "stale")));
    assert.equal((await source.readDocument("docs/000.md")).document!.workspaceRevision, 3);

    // Contract phase, after the dated previous-writer window: current writes no longer need the trigger.
    await fixture.adminPool.query("DROP TRIGGER ha_document_metadata_previous_writer ON ha_projection_values");
    await fixture.adminPool.query(
      "DROP FUNCTION ha_document_metadata_previous_writer(), ha_backfill_document_metadata(text,text,bigint,text,text), ha_document_metadata_from_value(text)",
    );
    await transaction((client) =>
      putPgProjectionValue(client, scope, "document", current.path, "", 4, document("current", 4)),
    );
    await transaction((client) => deletePgProjectionValue(client, scope, "document", large.path));
    assert.equal((await source.readDocumentMetadata(current.path)).document!.workspaceRevision, 4);
    assert.ok(!(await source.readDocuments("")).documents.some(({ path }) => path === large.path));
    await t.diagnostic(
      `v5-online-upgrade: initial=130 firstBatch=64 resumedBatches=${JSON.stringify(batches)} largeBytes=${large.size}; old/new read/write and contract passed`,
    );
  } finally {
    await fixture.pool.end();
    await fixture.close();
  }
});
