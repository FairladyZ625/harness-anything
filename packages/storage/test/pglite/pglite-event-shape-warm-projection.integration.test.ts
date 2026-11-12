// harness-test-tier: integration
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { eventShapeMigrationWritePlan } from "@harness-anything/kernel/internal/domain/event-shape-migration-event.ts";
import { sha256Text } from "@harness-anything/kernel/internal/integrity/stable-hash.ts";
import { createPgStorageBackend } from "../../src/pg/backend.ts";
import { createPGliteStorageBackend } from "../../src/pglite/storage-backend.ts";
import { applyAttachMigrations } from "../../src/store/attach-migrations.ts";
import { warmProjectionFixture } from "../store/event-shape-warm-projection.fixtures.ts";
import { pgliteIntegrationSuite } from "./pglite-runtime.fixture.ts";
import { assertCrossRepoShapeReplay } from "../postgres/event-shape-warm-replay.fixture.ts";

pgliteIntegrationSuite("PGlite event-shape warm projection", () => {
  test("a low-revision migration replays its repository and retains a higher-revision neighbor", async () => {
    const dataDir = mkdtempSync(path.join(tmpdir(), "ha-pglite-multi-shape-")),
      backend = await createPGliteStorageBackend({
        repoId: "pool-owner",
        storage: {
          backend: "pglite",
          dataDir,
          scope: { tenantId: "bootstrap", projectId: "bootstrap", policyEpoch: 1, readers: [] },
        },
      });
    try {
      await assertCrossRepoShapeReplay(backend.pool);
    } finally {
      await backend.close();
      rmSync(dataDir, { recursive: true, force: true });
    }
  });

  test("canonical acceptance replays old reduced rows once and preserves authorization", async () => {
    const dataDir = mkdtempSync(path.join(tmpdir(), "ha-pglite-shape-")),
      repoId = "warm-shape",
      scope = { tenantId: "shape-tenant", projectId: "shape-project", policyEpoch: 1, readers: ["historical-reader"] },
      storage = { backend: "pglite" as const, dataDir, scope },
      fixture = warmProjectionFixture(),
      fence = { repoId, holderId: "fixture", epoch: 1 };
    let backend = await createPGliteStorageBackend({
      repoId,
      storage,
      readAuthoredDocument: () => ({
        body: fixture.baseBody,
        sha256: sha256Text(fixture.baseBody),
        size: Buffer.byteLength(fixture.baseBody),
        nodeKind: "file",
      }),
    });
    try {
      await backend.eventStore.append(fixture.bundle, 0, fence);
      const unchanged = (await backend.pool.query("SELECT updated_at FROM ha_projection_meta")).rows;
      await backend.close();
      backend = await createPGliteStorageBackend({ repoId, storage });
      assert.deepEqual(
        (await backend.pool.query("SELECT updated_at FROM ha_projection_meta")).rows,
        unchanged,
        "warm reopen before any migration must not rebuild",
      );
      await backend.pool.query(
        "UPDATE ha_projection_values SET value=$1 WHERE model='entity:settings' AND entity_id='repository'",
        [
          JSON.stringify({
            ...(await backend.projection.getEntity("settings", "repository")),
            value: fixture.oldSettings,
          }),
        ],
      );
      // entity:settings's stored value is the entity row, including its historical Settings value.
      assert.deepEqual((await backend.projection.getEntity("settings", "repository"))?.value, fixture.oldSettings);
      assert.deepEqual(applyAttachMigrations({ store: fixture.migrationStore }).applied, ["settings.ci"]);
      const migration = fixture.events.at(-1)!,
        migrationBackend = createPgStorageBackend({
          pool: backend.pool,
          repoId,
          scope: { ...scope, readers: [...scope.readers, "migration-reader"] },
        });
      await migrationBackend.eventStore.append(
        {
          event: migration,
          plan: eventShapeMigrationWritePlan(migration as Parameters<typeof eventShapeMigrationWritePlan>[0]),
          blobs: [],
        },
        1,
        fence,
      );
      assert.deepEqual(
        (await backend.projection.getEntity("settings", "repository"))?.value,
        fixture.expected,
        "retired Settings.ci must disappear from the stored reduction",
      );
      assert.deepEqual(
        (
          await backend.pool.query(
            "SELECT readers FROM ha_projection_values WHERE model='entity:settings' AND entity_id='repository'",
          )
        ).rows[0]?.readers,
        scope.readers,
      );
      assert.equal((await backend.projection.readCut()).watermark, fixture.events.length);
      assert.equal((await backend.projection.readDocument("harness.yaml")).document?.body, fixture.body);
      const before = (await backend.pool.query("SELECT updated_at FROM ha_projection_meta")).rows;
      await backend.close();
      backend = await createPGliteStorageBackend({ repoId, storage });
      assert.deepEqual(
        (await backend.pool.query("SELECT updated_at FROM ha_projection_meta")).rows,
        before,
        "warm reopen with no new migration must not rebuild",
      );
      assert.deepEqual((await backend.projection.getEntity("settings", "repository"))?.value, fixture.expected);
    } finally {
      await backend.close();
      rmSync(dataDir, { recursive: true, force: true });
    }
  });
});
