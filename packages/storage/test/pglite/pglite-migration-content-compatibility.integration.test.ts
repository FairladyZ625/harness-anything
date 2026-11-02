// harness-test-tier: integration
import test from "node:test";
import { createPGliteStorageBackend } from "../../src/pglite/storage-backend.ts";
import { assertContentParity, repoId, scope } from "../postgres/pg-migration-content-compatibility.fixture.ts";
import { pgliteIntegrationSuite } from "./pglite-runtime.fixture.ts";

pgliteIntegrationSuite("PGlite migration content compatibility", () => {
  test("canonical NUL documents retain bytes, queries and headDigest on PGlite", async () => {
    const storage = await createPGliteStorageBackend({
      repoId,
      storage: { backend: "pglite", dataDir: "memory://", scope },
    });
    try {
      process.stdout.write(
        `CONTENT_SERVER PGlite ${(await storage.pool.query<{ version: string }>("SELECT version() AS version")).rows[0]!.version}\n`,
      );
      await assertContentParity(storage.pool, "PGlite");
    } finally {
      await storage.close();
    }
  });
});
