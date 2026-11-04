// harness-test-tier: integration
import test from "node:test";
import { createPGliteStorageBackend } from "../../src/pglite/storage-backend.ts";
import { pgliteIntegrationSuite } from "./pglite-runtime.fixture.ts";
import { assertEntityIndexes } from "../postgres/pg-entity-index.fixture.ts";

pgliteIntegrationSuite("PGlite current declarations", () => {
  test("live index excludes 100k deleted identities and rebuild repairs the complete current state", async () => {
    const backend = await createPGliteStorageBackend({
      repoId: "entity-index",
      storage: {
        backend: "pglite",
        scope: { tenantId: "entity-index", projectId: "entity-index", policyEpoch: 1 },
      },
    });
    try {
      await assertEntityIndexes(backend.pool, backend.pool, "pglite");
    } finally {
      await backend.close();
    }
  });
});
