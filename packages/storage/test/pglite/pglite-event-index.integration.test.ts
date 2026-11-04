// harness-test-tier: integration
import test from "node:test";
import { createPGliteStorageBackend } from "../../src/pglite/storage-backend.ts";
import { pgliteIntegrationSuite } from "./pglite-runtime.fixture.ts";
import { assertEventIndexes } from "../postgres/pg-event-index.fixture.ts";

pgliteIntegrationSuite("PGlite event indexes", () => {
  test("PGlite event indexes exclude unrelated history", async () => {
    const backend = await createPGliteStorageBackend({
      repoId: "event-index",
      storage: { backend: "pglite", scope: { tenantId: "event-index", projectId: "event-index", policyEpoch: 1 } },
    });
    try {
      await assertEventIndexes(backend.pool, backend.pool, "pglite");
    } finally {
      await backend.close();
    }
  });
});
