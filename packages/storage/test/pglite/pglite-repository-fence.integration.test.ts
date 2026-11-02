// harness-test-tier: integration
import test from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createPGliteStorageBackend } from "../../src/pglite/storage-backend.ts";
import { assertRepositoryMigrationFence } from "../migration/repository-fence.assertions.ts";
import { pgliteIntegrationSuite } from "./pglite-runtime.fixture.ts";

pgliteIntegrationSuite("PGlite repository migration fence", () => {
  test("Node 26: new tuples share the persisted repository fence", async (t) => {
    const root = mkdtempSync(path.join(tmpdir(), "ha-pglite-repo-fence-")),
      scope = { tenantId: "t", projectId: "p", policyEpoch: 0 },
      source = await createPGliteStorageBackend({
        repoId: "fixture",
        storage: { backend: "pglite", dataDir: path.join(root, "source"), scope },
      }),
      target = await createPGliteStorageBackend({
        repoId: "fixture",
        storage: { backend: "pglite", dataDir: path.join(root, "target"), scope },
      });
    try {
      await assertRepositoryMigrationFence(t, {
        source: source.pool,
        target: target.pool,
        runtime: source.pool,
        backend: "pglite",
      });
    } finally {
      await source.close();
      await target.close();
      rmSync(root, { recursive: true, force: true });
    }
  });
});
