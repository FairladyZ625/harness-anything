import assert from "node:assert/strict";
import type { TestContext } from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { Pool } from "pg";
import { createPgStorageBackend } from "../../src/pg/backend.ts";
import { migrateStorage } from "../../src/migration/engine.ts";
import { openPgMigrationEndpoint } from "../../src/migration/postgres-endpoint.ts";
import { bundle, eventAt } from "../store/task-event-store.fixtures.ts";

/** Exercise the ordinary accepting port, including tuple creation, on both sides of every cut. */
export async function assertRepositoryMigrationFence(
  t: TestContext,
  input: { source: Pool; target: Pool; runtime: Pool; backend: "postgres" | "pglite" },
) {
  for (const boundary of ["target_prepared", "audit_passed", "source_sealed", "target_marker"]) {
    await t.test(`${boundary}: unseen tuples cannot escape the repository authority`, async () => {
      const root = mkdtempSync(path.join(tmpdir(), "ha-repo-fence-")),
        repoId = `repo-${boundary}`,
        scope = { tenantId: "tenant-a", projectId: boundary, readers: [], policyEpoch: 0 },
        store = (pool: Pool, s = scope) => createPgStorageBackend({ pool, scope: s, repoId }).eventStore,
        endpoint = (pool: Pool, identity: string) =>
          openPgMigrationEndpoint({ pool, repoId, scope, backend: input.backend, identity });
      try {
        await store(input.runtime).append(bundle(eventAt(1)), 0, { repoId, holderId: "seed", epoch: 1 });
        const source = await endpoint(input.source, "source"),
          target = await endpoint(input.target, "target"),
          before = await source.export(boundary),
          args = { repoId, runId: boundary, source, target, exportDirectory: root };
        await assert.rejects(
          migrateStorage({
            ...args,
            checkpoint(at) {
              if (at === boundary) throw new Error(`interrupt:${boundary}`);
            },
          }),
          new RegExp(`interrupt:${boundary}`),
        );
        const highEpoch = (await source.epoch()) + 100;
        for (const [name, pool] of [
          ["source", input.runtime],
          ["target", input.target],
        ] as const) {
          // The current target becomes writable only after its marker. The source never does.
          if (name === "target" && boundary === "target_marker") continue;
          await Promise.all(
            [
              { ...scope, tenantId: "tenant-b" },
              { ...scope, projectId: `${boundary}-new` },
            ].map(async (unseen) => {
              await assert.rejects(
                store(pool, unseen).append(bundle(eventAt(1)), 0, { repoId, holderId: "late", epoch: highEpoch }),
                /storage_migration_read_only/,
                `${name} accepted a previously unseen tuple at ${boundary}`,
              );
              assert.equal(await store(pool, unseen).readHead(), null);
            }),
          );
          const rejected = store(pool, { ...scope, tenantId: "unseen-rejection" });
          await assert.rejects(
            rejected.execute({
              operation: "reject",
              expectedRevision: 0,
              writerFence: { repoId, holderId: "late", epoch: highEpoch },
              rejection: {
                opId: "rejected",
                intentDigest: `sha256:${"0".repeat(64)}`,
                summary: "probe",
                rejectionCode: "invalid_write_plan",
              },
            }),
            /storage_migration_read_only/,
          );
          assert.equal(await rejected.execute({ operation: "outcome", opId: "rejected" }), null);
        }
        if (boundary === "target_prepared") {
          // A prepared destination has no events yet. Its authority must survive even with no scoped heads.
          await input.target.query("DELETE FROM ha_repo_heads WHERE repo_id=$1", [repoId]);
          assert.equal((await target.state())!.phase, "prepared");
          await assert.rejects(
            store(input.target, { ...scope, tenantId: "without-heads" }).append(bundle(eventAt(1)), 0, {
              repoId,
              holderId: "late",
              epoch: highEpoch,
            }),
            /storage_migration_read_only/,
          );
        }
        // Reopen the management port: neither configuration nor surviving per-tuple heads decide authority.
        const reopened = await endpoint(input.source, "source");
        await migrateStorage({ ...args, source: reopened, mode: "resume" });
        assert.deepEqual(await target.export(boundary), before);
        assert.deepEqual(await reopened.export(boundary), before);
        assert.equal(await target.marker(boundary), true);
        await assert.rejects(
          store(input.runtime, { ...scope, tenantId: "tenant-after" }).append(bundle(eventAt(1)), 0, {
            repoId,
            holderId: "late",
            epoch: highEpoch,
          }),
          /storage_migration_read_only/,
        );
        // A newly created scope on the activated authority inherits the migration epoch floor.
        const current = store(input.target, { ...scope, tenantId: "tenant-current" });
        await assert.rejects(current.append(bundle(eventAt(1)), 0, { repoId, holderId: "stale", epoch: 1 }), {
          code: "revision_conflict",
        });
        await current.append(bundle(eventAt(1)), 0, { repoId, holderId: "fresh", epoch: highEpoch });
        assert.equal((await current.readHead())!.revision, 1);
        process.stdout.write(
          `DM1_${input.backend} ${boundary}: unseen source/target denied; audit exact; active target fresh epoch accepted\n`,
        );
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    });
  }
  await t.test("abort keeps new destination tuples sealed and resumes new source tuples at a newer epoch", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "ha-abort-repo-fence-")),
      repoId = "repo-abort",
      scope = { tenantId: "abort-a", projectId: "abort", readers: [], policyEpoch: 0 },
      source = await openPgMigrationEndpoint({
        pool: input.source,
        repoId,
        scope,
        backend: input.backend,
        identity: "source",
      }),
      target = await openPgMigrationEndpoint({
        pool: input.target,
        repoId,
        scope,
        backend: input.backend,
        identity: "target",
      }),
      store = (pool: Pool, tenantId: string) =>
        createPgStorageBackend({ pool, repoId, scope: { ...scope, tenantId } }).eventStore,
      args = { repoId, runId: "abort", source, target, exportDirectory: root };
    try {
      await store(input.runtime, "abort-a").append(bundle(eventAt(1)), 0, { repoId, holderId: "seed", epoch: 1 });
      await assert.rejects(
        migrateStorage({
          ...args,
          checkpoint(at) {
            if (at === "target_prepared") throw new Error("abort probe");
          },
        }),
        /abort probe/,
      );
      await migrateStorage({ ...args, mode: "abort" });
      const epoch = await source.epoch();
      await assert.rejects(
        store(input.runtime, "abort-stale").append(bundle(eventAt(1)), 0, { repoId, holderId: "stale", epoch: 1 }),
        { code: "revision_conflict" },
      );
      await store(input.runtime, "abort-new").append(bundle(eventAt(1)), 0, {
        repoId,
        holderId: "resumed",
        epoch: epoch + 1,
      });
      await assert.rejects(
        store(input.target, "abort-new").append(bundle(eventAt(1)), 0, {
          repoId,
          holderId: "late",
          epoch: epoch + 100,
        }),
        /storage_migration_read_only/,
      );
      assert.equal(await target.marker("abort"), false);
      process.stdout.write(
        `DM1_${input.backend} abort: abandoned new tuple denied; resumed source epoch floor preserved\n`,
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
}
