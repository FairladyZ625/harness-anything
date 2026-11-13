// harness-test-tier: integration
import test from "node:test";
import { join } from "node:path";
import { createPGliteStorageBackend } from "../../src/pglite/storage-backend.ts";
import { pgliteIntegrationSuite } from "./pglite-runtime.fixture.ts";
import { relationCycleAuditCases } from "../postgres/relation-cycle-audit.fixture.ts";

pgliteIntegrationSuite("PGlite relation cycle audit", () => {
  for (const [name, run] of Object.entries(
    relationCycleAuditCases((root, scope, repoId) =>
      createPGliteStorageBackend({ repoId, storage: { backend: "pglite", dataDir: join(root, "database"), scope } }),
    ),
  ))
    test(name, run);
});
