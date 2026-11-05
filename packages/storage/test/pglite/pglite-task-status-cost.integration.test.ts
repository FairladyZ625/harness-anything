// harness-test-tier: integration
import test from "node:test";
import { createPGliteStorageBackend } from "../../src/pglite/storage-backend.ts";
import { pgliteIntegrationSuite } from "./pglite-runtime.fixture.ts";
import { assertTaskStatusCost } from "../postgres/pg-task-status-cost.fixture.ts";

pgliteIntegrationSuite("PGlite task status read costs", () => {
  test("raw and presentation task reads exclude unrelated task history", async () => {
    const backend = await createPGliteStorageBackend({
      repoId: "task-status-cost",
      storage: {
        backend: "pglite",
        scope: { tenantId: "task-status-cost", projectId: "task-status-cost", policyEpoch: 1 },
      },
    });
    try {
      await assertTaskStatusCost(backend.pool, backend.pool, "pglite");
    } finally {
      await backend.close();
    }
  });
});
