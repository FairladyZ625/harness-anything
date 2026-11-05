// harness-test-tier: integration
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createPGliteStorageBackend } from "../../src/pglite/storage-backend.ts";
import { pgliteIntegrationSuite } from "./pglite-runtime.fixture.ts";

pgliteIntegrationSuite("runtime unsettled RLS", () => {
  test("the derived current-set table keeps forced RLS and the scope policy", async () => {
    const dataDir = mkdtempSync(path.join(os.tmpdir(), "ha-runtime-unsettled-rls-"));
    const backend = await createPGliteStorageBackend({
      repoId: "rls-check",
      storage: {
        backend: "pglite",
        dataDir,
        materialize: false,
        scope: { tenantId: "t", projectId: "p", policyEpoch: 0 },
      },
    });
    try {
      const relation = (
        await backend.pool.query(
          "SELECT relrowsecurity, relforcerowsecurity FROM pg_class WHERE oid='ha_runtime_unsettled'::regclass",
        )
      ).rows[0];
      assert.deepEqual(relation, { relrowsecurity: true, relforcerowsecurity: true });
      const policies = (
        await backend.pool.query(
          "SELECT polname, polqual IS NOT NULL AS has_using, polwithcheck IS NOT NULL AS has_check FROM pg_policy WHERE polrelid='ha_runtime_unsettled'::regclass",
        )
      ).rows;
      assert.ok(
        policies.some(
          (policy) => policy.polname === "ha_runtime_unsettled_scope_policy" && policy.has_using && policy.has_check,
        ),
      );
    } finally {
      await backend.close();
      rmSync(dataDir, { recursive: true, force: true });
    }
  });
});
