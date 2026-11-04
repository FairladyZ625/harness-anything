// harness-test-tier: integration
import test from "node:test";
import { createPGliteStorageBackend } from "../../src/pglite/storage-backend.ts";
import { pgliteIntegrationSuite } from "./pglite-runtime.fixture.ts";
import { assertValueIndexes } from "../postgres/pg-value-index.fixture.ts";

pgliteIntegrationSuite("PGlite value indexes", () => {
  test("PGlite value indexes exclude unrelated history", async () => {
    const backend = await createPGliteStorageBackend({
      repoId: "value-index",
      storage: { backend: "pglite", scope: { tenantId: "value-index", projectId: "value-index", policyEpoch: 1 } },
    });
    try {
      await assertValueIndexes(backend.pool, backend.pool, "pglite");
    } finally {
      await backend.close();
    }
  });
});
