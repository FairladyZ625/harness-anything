import assert from "node:assert/strict";
import type { Pool } from "pg";
import type { EntityProjectionRow } from "@harness-anything/kernel";
import { eventShapeMigrationWritePlan } from "@harness-anything/kernel/internal/domain/event-shape-migration-event.ts";
import { sha256Text } from "@harness-anything/kernel/internal/integrity/stable-hash.ts";
import { createPgStorageBackend } from "../../src/pg/backend.ts";
import { withPostgresTransaction } from "../../src/postgres/transaction.ts";
import { applyAttachMigrations } from "../../src/store/attach-migrations.ts";
import { warmProjectionFixture } from "../store/event-shape-warm-projection.fixtures.ts";
import { bundle, eventAt } from "../store/task-event-store.fixtures.ts";

/** The same canonical two-repository contract runs on native PG and PGlite. */
export async function assertCrossRepoShapeReplay(pool: Pool): Promise<void> {
  const scope = { tenantId: "multi-shape", projectId: "multi-shape", policyEpoch: 1 },
    readersA = ["historical-a"],
    readersB = ["historical-b"],
    fixture = warmProjectionFixture(),
    repoA = createPgStorageBackend({
      pool,
      repoId: "shape-a",
      scope: { ...scope, readers: readersA },
      readAuthoredDocument: () => ({
        body: fixture.baseBody,
        sha256: sha256Text(fixture.baseBody),
        size: Buffer.byteLength(fixture.baseBody),
        nodeKind: "file",
      }),
    }),
    repoB = createPgStorageBackend({ pool, repoId: "shape-b", scope: { ...scope, readers: readersB } }),
    fenceA = { repoId: "shape-a", holderId: "fixture", epoch: 1 },
    fenceB = { ...fenceA, repoId: "shape-b" },
    keys = [scope.tenantId, scope.projectId, scope.policyEpoch],
    query = (sql: string, values: readonly unknown[] = keys) =>
      withPostgresTransaction(pool, (client) => client.query(sql, [...values]), scope),
    meta = async () =>
      (
        await query(
          "SELECT watermark,source_revision,updated_at FROM ha_projection_meta WHERE tenant_id=$1 AND project_id=$2 AND policy_epoch=$3",
        )
      ).rows,
    otherRows = async () =>
      (
        await query(
          "SELECT task_id,snapshot,workspace_revision,readers FROM ha_task_snapshots WHERE tenant_id=$1 AND project_id=$2 AND policy_epoch=$3 ORDER BY task_id",
        )
      ).rows,
    settingsRow = async () => {
      const row = (
        await query(
          "SELECT value FROM ha_projection_values WHERE tenant_id=$1 AND project_id=$2 AND policy_epoch=$3 AND model='entity:settings' AND entity_id='repository'",
        )
      ).rows[0];
      assert.ok(row, "canonical A settings must have a stored projection row");
      return JSON.parse(row.value) as EntityProjectionRow;
    },
    legacyRow = async () => {
      const row = await settingsRow();
      await query(
        "UPDATE ha_projection_values SET value=$4 WHERE tenant_id=$1 AND project_id=$2 AND policy_epoch=$3 AND model='entity:settings' AND entity_id='repository'",
        [...keys, JSON.stringify({ ...row, value: fixture.oldSettings })],
      );
    };
  await repoA.eventStore.append(fixture.bundle, 0, fenceA);
  for (let revision = 1; revision <= 100; revision++)
    await repoB.eventStore.append(bundle(eventAt(revision)), revision - 1, fenceB);
  assert.equal((await repoA.eventStore.readHead())?.revision, 1);
  assert.equal((await repoB.eventStore.readHead())?.revision, 100);
  assert.equal(Number((await meta())[0]?.watermark), 100);
  const before = await otherRows();
  assert.equal(before.length, 100);
  assert.ok(before.every((row) => JSON.stringify(row.readers) === JSON.stringify(readersB)));
  await legacyRow();
  assert.deepEqual((await settingsRow()).value, fixture.oldSettings);
  assert.deepEqual(applyAttachMigrations({ store: fixture.migrationStore }).applied, ["settings.ci"]);
  const migration = fixture.events.at(-1)!,
    migrationBundle = {
      event: migration,
      plan: eventShapeMigrationWritePlan(migration as Parameters<typeof eventShapeMigrationWritePlan>[0]),
      blobs: [],
    },
    writer = createPgStorageBackend({
      pool,
      repoId: "shape-a",
      scope: { ...scope, readers: [...readersA, "migration-reader"] },
    });
  await writer.eventStore.append(migrationBundle, 1, fenceA);
  assert.deepEqual(
    (await settingsRow()).value,
    fixture.expected,
    "A migration at revision 2 must replay its old row even when B's scoped watermark is 100",
  );
  assert.deepEqual(await otherRows(), before, "scope rebuild must retain B's rows and original readers");
  const cut = (await meta())[0];
  assert.equal(Number(cut.watermark), 100);
  assert.equal(Number(cut.source_revision), 100);
  assert.deepEqual(
    (
      await query(
        "SELECT readers FROM ha_projection_values WHERE tenant_id=$1 AND project_id=$2 AND policy_epoch=$3 AND model='entity:settings' AND entity_id='repository'",
      )
    ).rows[0]?.readers,
    readersA,
  );
  // A legacy cached row witnesses replay: a duplicate command and an ordinary B delta must
  // leave it alone. Canonical op-id admission, rather than a cross-repository cut, owns newness.
  await legacyRow();
  await writer.eventStore.append(migrationBundle, 1, fenceA);
  assert.deepEqual((await meta())[0], cut, "a replayed migration command must not invoke projection rebuild");
  assert.deepEqual((await settingsRow()).value, fixture.oldSettings);
  await repoB.eventStore.append(bundle(eventAt(101)), 100, fenceB);
  assert.deepEqual((await settingsRow()).value, fixture.oldSettings);
  assert.equal((await otherRows()).length, 101);
  assert.equal((await repoA.eventStore.readHead())?.revision, 2);
  assert.equal((await repoB.eventStore.readHead())?.revision, 101);
}
