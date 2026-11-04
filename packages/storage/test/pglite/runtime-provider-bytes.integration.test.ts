// harness-test-tier: integration
import test from "node:test";
import { join } from "node:path";
import { assertRuntimeProviderBytes } from "../runtime-provider-bytes.assertions.ts";
import { makeTaskEventStore } from "../../src/store/task-event-store.ts";
import { pgRuntimeFixture } from "../postgres/pg-runtime.fixture.ts";
import { withTempStoreAsync } from "../store/helpers.ts";
import { pgliteIntegrationSuite } from "./pglite-runtime.fixture.ts";
import { createPGliteStorageBackend } from "../../src/pglite/storage-backend.ts";
import { assertRuntimeIndexReplacement } from "../postgres/pg-runtime-index-replacement.fixture.ts";

pgliteIntegrationSuite("runtime provider bytes", () => {
  test("isolated PGlite candidate: retiring only the expression index repairs the same accepted bytes", async () => {
    const scope = { tenantId: "candidate", projectId: "candidate", policyEpoch: 1 },
      backend = await createPGliteStorageBackend({
        repoId: "provider-replacement",
        storage: { backend: "pglite", scope },
      });
    try {
      await assertRuntimeIndexReplacement(backend.pool, backend.pool, scope);
    } finally {
      await backend.close();
    }
  });
  for (const backend of ["sqlite", "pglite"] as const)
    test(`${backend} preserves accepted opaque provider bytes`, async () => {
      await withTempStoreAsync(async (rootDir) => {
        const storage =
            backend === "sqlite"
              ? { backend }
              : {
                  backend,
                  dataDir: join(rootDir, "database"),
                  scope: { tenantId: "provider", projectId: "provider", policyEpoch: 1 },
                },
          store = makeTaskEventStore({ repoId: "provider-bytes", rootDir, storage });
        try {
          assertRuntimeProviderBytes(store);
        } finally {
          await store.drain();
        }
      });
    });
});
test("isolated PG candidate: retiring only the expression index repairs the same accepted bytes", async () => {
  const fixture = await pgRuntimeFixture();
  try {
    await assertRuntimeIndexReplacement(fixture.pool, fixture.adminPool, {
      tenantId: "candidate",
      projectId: "candidate",
      policyEpoch: 1,
    });
  } finally {
    await fixture.pool.end();
    await fixture.close();
  }
});
test("PG preserves accepted opaque provider bytes", async () => {
  const fixture = await pgRuntimeFixture(),
    storage = {
      backend: "postgres" as const,
      connectionString: fixture.connectionString,
      scope: { tenantId: "provider", projectId: "provider", policyEpoch: 1 },
    },
    store = makeTaskEventStore({ repoId: "provider-bytes", rootDir: join(fixture.root, "workspace"), storage });
  try {
    assertRuntimeProviderBytes(store);
  } finally {
    await store.drain();
    await fixture.pool.end();
    await fixture.close();
  }
});
