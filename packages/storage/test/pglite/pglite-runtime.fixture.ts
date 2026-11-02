import assert from "node:assert/strict";
import { describe as suite, test as runtimeTest } from "node:test";
import { createPgDialectStorageBackend, createPGliteStorage, createPGliteStorageBackend } from "../../src/index.ts";

/** Node 24 exercises refusal; the Node 26 CI lane executes every database assertion. */
export function pgliteIntegrationSuite(name: string, databaseTests: () => void): void {
  suite(name, () => {
    if (Number(process.versions.node.split(".")[0]) >= 26) {
      databaseTests();
      return;
    }
    runtimeTest("unsupported Node refuses every PGlite factory before opening WASM", async () => {
      const expected = { code: "pglite_runtime_unsupported" };
      assert.throws(() => createPGliteStorage(), expected);
      const storage = {
        backend: "pglite",
        scope: { tenantId: "runtime-tenant", projectId: "runtime-project", policyEpoch: 0 },
      } as const;
      await assert.rejects(createPGliteStorageBackend({ repoId: "runtime", storage }), expected);
      await assert.rejects(createPgDialectStorageBackend({ repoId: "runtime", storage }), expected);
    });
  });
}
