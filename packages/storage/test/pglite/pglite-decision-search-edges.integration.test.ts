// harness-test-tier: integration
import test from "node:test";
import { createPGliteStorageBackend } from "../../src/pglite/storage-backend.ts";
import { pgliteIntegrationSuite } from "./pglite-runtime.fixture.ts";
import { assertDecisionSearchEdges } from "../postgres/decision-search-edges.fixture.ts";
pgliteIntegrationSuite("Unicode61 positions", () => {
  test("PGlite positions retain SQLite's complete literal phrase contract", async () => {
    const backend = await createPGliteStorageBackend({
      repoId: "search-edges",
      storage: { backend: "pglite", scope: { tenantId: "search-edges", projectId: "search-edges", policyEpoch: 1 } },
    });
    try {
      await assertDecisionSearchEdges(backend.pool, "pglite");
    } finally {
      await backend.close();
    }
  });
});
