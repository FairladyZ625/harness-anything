// harness-test-tier: integration
import test from "node:test";
import { createPGliteStorageBackend } from "../../src/pglite/storage-backend.ts";
import { pgliteIntegrationSuite } from "./pglite-runtime.fixture.ts";
import { assertSessionIndexes } from "../postgres/pg-session-index.fixture.ts";

pgliteIntegrationSuite("PGlite session indexes", () => {
  test("PGlite task sessions and batches exclude unrelated history", async () => {
    const backend = await createPGliteStorageBackend({
      repoId: "session-index",
      storage: { backend: "pglite", scope: { tenantId: "session-index", projectId: "session-index", policyEpoch: 1 } },
    });
    try {
      await assertSessionIndexes(backend.pool, backend.pool, "pglite");
    } finally {
      await backend.close();
    }
  });
});
