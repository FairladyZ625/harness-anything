// harness-test-tier: integration
import test from "node:test";
import { createPGliteStorageBackend } from "../../src/pglite/storage-backend.ts";
import { pgliteIntegrationSuite } from "./pglite-runtime.fixture.ts";
import { assertDocumentIndex } from "../postgres/pg-document-index.fixture.ts";

pgliteIntegrationSuite("PGlite document prefix index", () => {
  test("PGlite scans the matching document range", async () => {
    const backend = await createPGliteStorageBackend({
      repoId: "document-index",
      storage: {
        backend: "pglite",
        scope: { tenantId: "document-index", projectId: "document-index", policyEpoch: 1 },
      },
    });
    try {
      await assertDocumentIndex(backend.pool, backend.pool, "pglite");
    } finally {
      await backend.close();
    }
  });
});
