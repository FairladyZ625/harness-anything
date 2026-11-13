// harness-test-tier: integration
import assert from "node:assert/strict";
import { createServer, type AddressInfo } from "node:net";
import test from "node:test";
import { createPgStorageBackend } from "../../src/pg/backend.ts";
import { openStorageMigrationEndpoint } from "../../src/migration/open.ts";
import { bundle, eventAt } from "../store/task-event-store.fixtures.ts";
import { pgRuntimeFixture } from "../postgres/pg-runtime.fixture.ts";

test("openStorageMigrationEndpoint prefers authorityConnectionString over pooled connectionString", async () => {
  const fixture = await pgRuntimeFixture();
  let trapHits = 0;
  const trap = createServer((socket) => {
    trapHits++;
    socket.destroy();
  });
  try {
    await new Promise<void>((resolve, reject) => {
      trap.once("error", reject);
      trap.listen(0, "127.0.0.1", () => resolve());
    });
    const trapPort = (trap.address() as AddressInfo).port;
    const repoId = "migration-direct-entry";
    const scope = { tenantId: "tenant-direct", projectId: "project-direct", readers: [], policyEpoch: 0 };

    await createPgStorageBackend({ pool: fixture.pool, repoId, scope }).eventStore.append(bundle(eventAt(1)), 0, {
      repoId,
      holderId: "seed",
      epoch: 1,
    });

    const endpoint = await openStorageMigrationEndpoint(repoId, {
      storage: {
        backend: "postgres",
        connectionString: `postgres://ha_runtime:unused@127.0.0.1:${trapPort}/postgres`,
        authorityConnectionString: fixture.managementConnectionString,
        scope,
      },
    });
    try {
      const tuples = await endpoint.export("direct-entry-run");
      assert.equal(tuples.length, 1);
      assert.equal(tuples[0]!.events.length, 1);
      assert.equal(trapHits, 0, "migration endpoint must connect via authorityConnectionString, not connectionString");
    } finally {
      await endpoint.close();
    }

    // Without authorityConnectionString, the entry falls back to connectionString (here the restricted runtime role).
    await assert.rejects(
      openStorageMigrationEndpoint(repoId, {
        storage: {
          backend: "postgres",
          connectionString: fixture.connectionString,
          scope,
        },
      }),
      { code: "42501" },
    );
  } finally {
    await new Promise<void>((resolve) => trap.close(() => resolve()));
    await fixture.pool.end();
    await fixture.close();
  }
});
