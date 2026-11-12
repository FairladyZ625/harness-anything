// harness-test-tier: integration
import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import { compileSettingsChangedEvent } from "@harness-anything/kernel/internal/domain/settings-event.ts";
import { eventShapeMigrationWritePlan } from "@harness-anything/kernel/internal/domain/event-shape-migration-event.ts";
import { makeTaskProjection } from "../../src/projection/rebuildable-task-projection.ts";
import { applyAttachMigrations } from "../../src/store/attach-migrations.ts";
import { withTempStoreAsync } from "./helpers.ts";
import { warmProjectionFixture } from "./event-shape-warm-projection.fixtures.ts";

for (const mode of ["catchUp", "catchUpAsync", "apply", "reopen"] as const) {
  test(`SQLite ${mode} replays a warm historical projection when attach migrates its shape`, async () => {
    await withTempStoreAsync(async (rootDir) => {
      const fixture = warmProjectionFixture(),
        options = { rootDir, eventStore: fixture.eventStore, catchUpLimit: 1 },
        old = makeTaskProjection(options);
      old.catchUp();
      old.close();
      // The previous binary reduced this real historical event before retiring Settings.ci.
      const db = new DatabaseSync(old.path);
      db.prepare(
        "UPDATE entity_projection SET value_json=? WHERE entity_kind='settings' AND entity_id='repository'",
      ).run(JSON.stringify(fixture.oldSettings));
      db.close();
      let warm = makeTaskProjection(options);
      assert.deepEqual(warm.getEntity("settings", "repository")?.value, fixture.oldSettings);
      assert.deepEqual(applyAttachMigrations({ store: fixture.migrationStore }).applied, ["settings.ci"]);
      if (mode === "reopen") {
        warm.close();
        warm = makeTaskProjection(options);
      }
      fixture.scanned.length = 0;
      const migration = fixture.events.at(-1)!;
      if (mode === "apply")
        warm.apply(
          migration,
          eventShapeMigrationWritePlan(migration as Parameters<typeof eventShapeMigrationWritePlan>[0]),
        );
      else if (mode === "reopen") warm.catchUp();
      else await warm[mode]();
      assert.deepEqual(
        warm.getEntity("settings", "repository")?.value,
        fixture.expected,
        "retired Settings.ci must disappear from the stored reduction",
      );
      assert.ok(fixture.scanned.includes(1), "migration must replay the old canonical event");
      assert.equal(warm.readCut().watermark, fixture.events.length);
      assert.equal(warm.readDocument("harness.yaml").document?.body, fixture.body);
      const cold = makeTaskProjection({ ...options, projectionPath: path.join(rootDir, "cold.sqlite") });
      cold.catchUp();
      assert.equal(warm.readStateDigest(), cold.readStateDigest());
      cold.close();
      warm.close();
      fixture.scanned.length = 0;
      const reopened = makeTaskProjection(options);
      assert.equal(reopened.catchUp().metrics.reducedItems, 0);
      assert.deepEqual(fixture.scanned, [], "already-applied migrations must not rebuild on reopen");
      reopened.close();
    });
  });
}

test("SQLite warm open without a pending migration performs no replay", async () => {
  await withTempStoreAsync(async (rootDir) => {
    const fixture = warmProjectionFixture(),
      options = { rootDir, eventStore: fixture.eventStore },
      old = makeTaskProjection(options);
    old.catchUp();
    old.close();
    fixture.scanned.length = 0;
    const warm = makeTaskProjection(options);
    assert.equal(warm.catchUp().metrics.reducedItems, 0);
    assert.deepEqual(fixture.scanned, []);
    assert.deepEqual(warm.getEntity("settings", "repository")?.value, fixture.expected);
    const next = compileSettingsChangedEvent({
      ...fixture.bundle.event,
      settings: fixture.expected,
      baseDocumentBody: fixture.body,
      candidateDocumentBody: fixture.body,
      eventId: "event-current-settings",
      opId: "current-settings",
      workspaceRevision: 2,
    });
    fixture.events.push(next.event);
    assert.equal(warm.catchUp().metrics.reducedItems, 1);
    assert.deepEqual(fixture.scanned, [2], "ordinary delta must not replay the warm prefix");
    warm.close();
  });
});
