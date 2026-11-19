// harness-test-tier: integration
import assert from "node:assert/strict";
import { join } from "node:path";
import test from "node:test";
import type { InboxItem } from "@harness-anything/kernel/internal/domain/inbox.ts";
import { getPgProjectionValue } from "../../src/pg/pg-projection-values.ts";
import { createPGliteStorageBackend } from "../../src/pglite/storage-backend.ts";
import { assertInboxBackendParity, assertInboxReopenedReads } from "../inbox-parity.assertions.ts";
import { withTempStoreAsync } from "../store/helpers.ts";
import { pgliteIntegrationSuite } from "./pglite-runtime.fixture.ts";

pgliteIntegrationSuite("PGlite Inbox projection", () => {
  test("(e) PGlite answers every Inbox read exactly like SQLite and refolds a stale model version", async () => {
    await withTempStoreAsync(async (rootDir) => {
      const repoId = "pglite-inbox",
        storage = {
          backend: "pglite" as const,
          dataDir: join(rootDir, "database"),
          scope: { tenantId: "t", projectId: "p", policyEpoch: 1 },
        };
      const expected = await assertInboxBackendParity({ rootDir, repoId, storage });

      const backend = await createPGliteStorageBackend({ repoId, storage });
      try {
        const projectedReaders = (
          await backend.pool.query<{ readonly readers: string[] }>(
            `SELECT readers FROM ha_projection_values
             WHERE tenant_id='t' AND project_id='p' AND policy_epoch=1
               AND model='inbox-item' AND owner_id='person:owner' AND entity_id='peer-request'`,
          )
        ).rows[0]?.readers;
        assert.ok(projectedReaders, "the person Inbox row has a PostgreSQL readers list");
        assert.deepEqual([...projectedReaders].sort(), ["owner", "person-inbox"].sort());
        const client = await backend.pool.connect();
        try {
          for (const personId of ["person-inbox", "owner"]) {
            const item = await getPgProjectionValue<InboxItem>(
              client,
              { tenantId: "t", projectId: "p", policyEpoch: 1, readers: [personId] },
              "inbox-item",
              "peer-request",
              "person:owner",
            );
            assert.equal(item?.itemId, "peer-request", `${personId} can read the peer Inbox item`);
          }
        } finally {
          client.release();
        }
        await backend.pool.query(
          "DELETE FROM ha_projection_values WHERE model IN ('inbox-item', 'inbox-dedupe', 'inbox-queue')",
        );
        await backend.pool.query("UPDATE ha_projection_meta SET inbox_version=0");
        assert.equal(
          (
            await backend.projection.readInbox({
              by: "queue",
              status: "pending",
              consumerKind: "unattended_dispatch",
            })
          ).status,
          "pending",
        );
      } finally {
        await backend.close();
      }
      await assertInboxReopenedReads({ rootDir, repoId, storage, expected });
    });
  });
});
