// harness-test-tier: integration
import assert from "node:assert/strict";
import { join } from "node:path";
import test from "node:test";
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
        await backend.pool.query(
          "DELETE FROM ha_projection_values WHERE model IN ('inbox-item', 'inbox-dedupe', 'inbox-queue')",
        );
        await backend.pool.query("UPDATE ha_projection_meta SET inbox_version=0");
        assert.equal((await backend.projection.readInbox({ by: "queue", status: "pending" })).status, "pending");
      } finally {
        await backend.close();
      }
      await assertInboxReopenedReads({ rootDir, repoId, storage, expected });
    });
  });
});
