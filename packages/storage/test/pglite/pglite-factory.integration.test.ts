// harness-test-tier: integration
import { assertEntityFactory } from "../entity-factory.assertions.ts";
import { openEntityStore } from "../../src/store/entity-store.ts";
import assert from "node:assert/strict";
import { join } from "node:path";
import test from "node:test";
import type { Pool } from "pg";
import { makeTaskEventStore } from "../../src/store/task-event-store.ts";
import { makeTaskProjection, makeTaskProjectionReader } from "../../src/projection/rebuildable-task-projection.ts";
import { assertWriterEpochFactory } from "../writer-epoch-factory.assertions.ts";
import { assertCanonicalFactoryLifecycle } from "../canonical-factory.assertions.ts";
import { withTempStoreAsync } from "../store/helpers.ts";
import { pgliteIntegrationSuite } from "./pglite-runtime.fixture.ts";
import { createPGliteStorageBackend } from "../../src/pglite/storage-backend.ts";
import { docBundle } from "../store/task-event-store.fixtures.ts";
import {
  canonicalJson,
  hashCanonicalJsonTextFieldChunksAsync,
} from "../../src/projection/rebuildable-task-projection-sql.ts";
import { sha256Text } from "@harness-anything/kernel/internal/integrity/stable-hash.ts";
import { pgProjectionStoredRows } from "../../src/pg/pg-projection-stored-rows.ts";
import { PG_PROJECTION_AUDIT_TABLES } from "../../src/pg/pg-projection-schema.ts";
import { withPostgresTransaction } from "../../src/postgres/transaction.ts";

pgliteIntegrationSuite("PGlite synchronous factories", () => {
  test("canonical, projection and independent readers share one durable owner", async () => {
    await withTempStoreAsync(async (rootDir) => {
      const repoId = "pglite-factory",
        storage = {
          backend: "pglite" as const,
          dataDir: join(rootDir, "database"),
          materialize: false,
          scope: { tenantId: "tenant", projectId: "project", policyEpoch: 1 },
        },
        store = makeTaskEventStore({ repoId, rootDir, storage }),
        projection = makeTaskProjection({ rootDir, eventStore: store, storage });
      try {
        const { events, snapshot } = assertCanonicalFactoryLifecycle({
          store,
          projection,
          taskId: "task-factory",
          executionId: "execution-factory",
          reader: () => makeTaskProjectionReader({ repoId, storage }),
        });
        assertEntityFactory({
          store,
          open: () => openEntityStore(rootDir, { repoId, storage }),
          withReadSession: (read) => {
            const reader = makeTaskProjectionReader({ repoId, storage });
            try {
              reader.withSession(() => read());
            } finally {
              reader.close();
            }
          },
        });
        // Closing one facade cannot stop the owner still used by the other facade.
        projection.close();
        assert.equal(store.readHead()?.revision, events.length + 5);
        await store.drain();
        // Simulate a pre-expansion database, using the physical owner only after all facades closed.
        const old = await createPGliteStorageBackend({ repoId, storage });
        try {
          await old.pool.query("DELETE FROM ha_entity_declaration_heads");
          await old.pool.query("UPDATE ha_projection_meta SET entity_declaration_watermark=0");
        } finally {
          await old.close();
        }
        const progress: number[] = [];
        const reopened = makeTaskEventStore({ repoId, rootDir, storage }),
          reader = makeTaskProjectionReader({ repoId, storage }),
          warmed = makeTaskProjection({
            rootDir,
            eventStore: reopened,
            storage,
            catchUpLimit: 1,
            onProgress: ({ watermark }) => progress.push(watermark),
          });
        try {
          const receipt = await warmed.catchUpAsync!();
          assert.equal(receipt.watermark, events.length + 5);
          assert.equal(receipt.metrics.maxBatchItems, 1);
          assert.deepEqual(
            progress,
            Array.from({ length: events.length + 5 }, (_, i) => i + 1),
          );
          assert.equal(warmed.catchUp!().metrics.reducedItems, 0);
          assert.equal(reopened.readHead()?.revision, events.length + 5);
          assert.deepEqual(
            reader.withSession((queries) => queries.read("task-factory").snapshot),
            snapshot,
          );
        } finally {
          warmed.close();
          reader.close();
          await reopened.drain();
        }
      } finally {
        projection.close();
        await store.drain();
      }
    });
  });
  test("embedded append fence releases the physical session for its canonical append", async () => {
    await withTempStoreAsync(async (rootDir) => {
      await assertWriterEpochFactory({
        rootDir,
        repoId: "pglite-epoch",
        storage: {
          backend: "pglite",
          dataDir: join(rootDir, "database"),
          materialize: false,
          scope: { tenantId: "epoch", projectId: "epoch", policyEpoch: 1 },
        },
      });
    });
  });
  test("PGlite state digest streams document values larger than its read chunk", async () => {
    await withTempStoreAsync(async (rootDir) => {
      const body = "😀".repeat(300_000),
        chunkCharacters = (1024 * 1024) / 4,
        expectedRow = {
          model: "document",
          owner_id: "",
          entity_id: "tasks/task-digest/artifacts/large.md",
          workspace_revision: 1,
          value: body,
        },
        expectedCanonicalDigest = sha256Text(`f${"f".repeat(63)}\n${canonicalJson(expectedRow)}`);
      const repoId = "pglite-state-digest",
        storage = {
          backend: "pglite" as const,
          dataDir: join(rootDir, "database"),
          materialize: false,
          scope: { tenantId: "tenant", projectId: "project", policyEpoch: 1 },
        },
        store = makeTaskEventStore({ repoId, rootDir, storage }),
        projection = makeTaskProjection({ rootDir, eventStore: store, storage });
      try {
        const revision = (store.readHead()?.revision ?? 0) + 1;
        store.append(
          docBundle(store, body, revision, "state-digest-large-document", "tasks/task-digest/artifacts/large.md"),
        );
        const rebuilt = await projection.catchUpAsync!();
        assert.equal(rebuilt.watermark, revision);
        const digest = await projection.readStateDigest();
        assert.match(digest!, /^sha256:[a-f0-9]{64}$/u);
        assert.equal(await projection.readStateDigest(), digest);

        async function* contiguousCharacterChunks(): AsyncIterable<Uint8Array> {
          for (let offset = 0; offset < body.length; offset += chunkCharacters)
            yield Buffer.from(body.slice(offset, offset + chunkCharacters), "utf8");
        }
        assert.equal(
          await hashCanonicalJsonTextFieldChunksAsync(
            `f${"f".repeat(63)}`,
            { ...expectedRow, value: "" },
            "value",
            contiguousCharacterChunks(),
          ),
          expectedCanonicalDigest,
        );

        projection.close();
        await store.drain();
        const backend = await createPGliteStorageBackend({ repoId, storage });
        try {
          assert.equal(digest, await readCanonicalPGliteStateDigest(backend.pool, repoId, storage.scope));
        } finally {
          await backend.close();
        }
        return;
      } finally {
        projection.close();
        await store.drain();
      }
    });
  });
});

async function readCanonicalPGliteStateDigest(
  pool: Pool,
  repoId: string,
  scope: { readonly tenantId: string; readonly projectId: string; readonly policyEpoch: number },
): Promise<string> {
  const readers: readonly string[] = [];
  return withPostgresTransaction(
    pool,
    async (client) => {
      const parameters = [scope.tenantId, scope.projectId, scope.policyEpoch, readers];
      let digest = sha256Text("pg-task-projection-state/v1");
      for (const table of PG_PROJECTION_AUDIT_TABLES.filter((name) => name !== "ha_projection_meta")) {
        digest = sha256Text(`${digest}\n${table}`);
        if (table === "ha_projection_values") {
          const result = await client.query<{
            row_value: Record<string, unknown>;
            value: string;
          }>(
            `SELECT (to_jsonb(projection) - ARRAY['tenant_id','project_id','policy_epoch','readers'] - 'value') AS row_value,
                    projection.value
               FROM ha_projection_values projection
              WHERE projection.tenant_id=$1 AND projection.project_id=$2 AND projection.policy_epoch=$3
                AND (cardinality($4::text[])=0 OR projection.readers && $4::text[])
              ORDER BY (to_jsonb(projection) - ARRAY['tenant_id','project_id','policy_epoch','readers'])::text`,
            parameters,
          );
          for (const row of result.rows)
            digest = sha256Text(`${digest}\n${canonicalJson({ ...row.row_value, value: row.value })}`);
          continue;
        }
        const stored = pgProjectionStoredRows(table),
          result = await client.query<{ row_value: Record<string, unknown> }>(
            `SELECT (${stored.row}) - ARRAY['tenant_id','project_id','policy_epoch','readers'] AS row_value
               FROM ${stored.from}
              WHERE projection.tenant_id=$1 AND projection.project_id=$2 AND projection.policy_epoch=$3
                AND (cardinality($4::text[])=0 OR projection.readers && $4::text[])
              ORDER BY ${table === "ha_entity_declaration_heads" ? "entity_kind,entity_id" : `((${stored.row}) - ARRAY['tenant_id','project_id','policy_epoch','readers'])::text`}`,
            parameters,
          );
        for (const { row_value } of result.rows) {
          const value =
            table === "ha_entity_declaration_heads"
              ? { ...row_value, state: JSON.parse(String(row_value.state)) }
              : row_value;
          digest = sha256Text(`${digest}\n${canonicalJson(value)}`);
        }
      }
      const events = await client.query<{ event_json: string }>(
        `SELECT event.event_json
           FROM ha_events event
          WHERE event.tenant_id=$1 AND event.project_id=$2 AND event.repo_id=$3 AND event.policy_epoch=$4
            AND event.event_type <> 'ci_run_observed'
            AND (cardinality($5::text[])=0 OR event.readers && $5::text[])
            AND event.revision <= (
              SELECT watermark FROM ha_projection_meta
               WHERE tenant_id=$1 AND project_id=$2 AND policy_epoch=$4 AND projection_name='task/v1'
            )
          ORDER BY event.revision`,
        [scope.tenantId, scope.projectId, repoId, scope.policyEpoch, readers],
      );
      for (const { event_json } of events.rows) digest = sha256Text(`${digest}\n${event_json}`);
      return `sha256:${digest}`;
    },
    scope,
  );
}
