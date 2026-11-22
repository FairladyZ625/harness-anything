// harness-test-tier: integration
import test from "node:test";
import { join } from "node:path";
import { mkdirSync } from "node:fs";
import { initRepo } from "../../storage/test/store/task-event-store.fixtures.ts";
import { withTempStoreAsync } from "../../storage/test/store/helpers.ts";
import { pgliteIntegrationSuite } from "../../storage/test/pglite/pglite-runtime.fixture.ts";
import { assertDossierRepoCell } from "./fixtures/dossier-repo-cell.ts";
import { assertRepoCellStorage } from "./repo-cell-storage.fixture.ts";

test("SQLite dossier synthesis shares a fence, validates content, and survives reopen", async () => {
  await withTempStoreAsync((root) => assertDossierRepoCell(root, { backend: "sqlite" }));
});

pgliteIntegrationSuite("daemon storage behavior", () => {
  test("PGlite persists the same dossier fence, validated content, and restart state", async () => {
    await withTempStoreAsync((root) =>
      assertDossierRepoCell(root, {
        backend: "pglite",
        dataDir: join(root, "database"),
        scope: { tenantId: "tenant", projectId: "dossier", readers: [], policyEpoch: 1 },
      }),
    );
  });

  for (const backend of ["sqlite", "pglite"] as const)
    test(`${backend} RepoCell writes, restarts and restores canonical documents`, async () => {
      await withTempStoreAsync(async (root) => {
        if (backend === "sqlite") {
          mkdirSync(join(root, "repository"), { recursive: true });
          initRepo(join(root, "repository"));
        }
        await assertRepoCellStorage(
          join(root, "repository"),
          backend === "sqlite"
            ? { backend }
            : {
                backend,
                dataDir: join(root, "database"),
                scope: { tenantId: "tenant", projectId: "project", readers: ["person-1"], policyEpoch: 1 },
              },
        );
      });
    });
});
