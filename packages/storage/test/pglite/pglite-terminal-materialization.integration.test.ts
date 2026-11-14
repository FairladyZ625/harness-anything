// harness-test-tier: integration
import test from "node:test";
import { createPGliteStorageBackend } from "../../src/pglite/storage-backend.ts";
import { assertTerminalMaterialization } from "../terminal-materialization.fixture.ts";
import { pgliteIntegrationSuite } from "./pglite-runtime.fixture.ts";

pgliteIntegrationSuite("PGlite terminal materialization contract", () => {
  test("terminal documents retain canonical holds and unlock incrementally", async () => {
    const repoId = "pglite-terminal-materialization",
      backend = await createPGliteStorageBackend({
        repoId,
        storage: {
          backend: "pglite",
          dataDir: `memory://${repoId}`,
          scope: { tenantId: "terminal", projectId: "materialization", policyEpoch: 0, readers: [] },
        },
      });
    let revision = 0;
    try {
      await assertTerminalMaterialization({
        append: async (bundle) => {
          await backend.eventStore.append(bundle, revision, { repoId, holderId: "fixture", epoch: 1 });
          revision++;
        },
        document: async (path) => (await backend.projection.readDocument(path)).document,
        history: async (path) => (await backend.projection.readDocumentHistory(path)).document,
        fact: async (id) => (await backend.projection.readFact(id)).fact,
        decision: async (id) => (await backend.projection.readDecision(id)).decision,
      });
    } finally {
      await backend.close();
    }
  });
});
