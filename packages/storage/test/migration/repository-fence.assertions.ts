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
}
