// harness-test-tier: integration
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createPGliteStorageBackend } from "../../src/pglite/storage-backend.ts";
import { createPgStorageBackend } from "../../src/pg/backend.ts";
import { contractPgEventSummaryIndex } from "../../src/pg/pg-event-read-index-migration.ts";
import { ensurePgProjectionSchema } from "../../src/pg/pg-projection-schema.ts";
import { rebuildPgProjection } from "../../src/pg/pg-task-event-materialize.ts";
import { withPostgresTransaction } from "../../src/postgres/transaction.ts";
import { openPgMigrationEndpoint } from "../../src/migration/postgres-endpoint.ts";
import { migrateStorage } from "../../src/migration/engine.ts";
import { bundle, eventAt } from "../store/task-event-store.fixtures.ts";
import { pgliteIntegrationSuite } from "./pglite-runtime.fixture.ts";

pgliteIntegrationSuite("fleet summary upgrade", () => {
  test("a completed-v5 old database is backfilled by the existing event upgrade call before fleet reads", async () => {
    const dataDir = mkdtempSync(path.join(os.tmpdir(), "ha-fleet-summary-upgrade-"));
    const backend = await createPGliteStorageBackend({
      repoId: "summary-upgrade",
      storage: {
        backend: "pglite",
        dataDir,
        materialize: false,
        scope: { tenantId: "t", projectId: "p", policyEpoch: 0 },
      },
    });
    try {
      await backend.pool.query(
        "INSERT INTO ha_repo_heads(tenant_id,project_id,repo_id,revision,policy_epoch,readers) VALUES ('t','p','summary-upgrade',0,0,'{}')",
      );
      for (let revision = 1; revision <= 65; revision += 1) {
        const event = {
          eventId: `event-${revision}`,
          workspaceRevision: revision,
          opId: `op-${revision}`,
          schema: "task-event/v1",
          type: "task_created",
          occurredAt: "2026-11-05T00:00:00.000Z",
          actor: { principal: { personId: "p" }, executor: null },
          source: "local",
          payload: { task: { taskId: `task_${revision}`, title: `t${revision}`, status: "active" } },
        };
        await backend.pool.query(
          `INSERT INTO ha_events(tenant_id,project_id,repo_id,revision,op_id,event_id,event_type,event_json,event_digest,occurred_at,policy_epoch,readers)
           VALUES ('t','p','summary-upgrade',$1,$2,$3,'task_created',$4,'sha256:x','2026-11-05T00:00:00.000Z',0,'{}')`,
          [revision, `op-${revision}`, `event-${revision}`, JSON.stringify(event)],
        );
      }
      await backend.pool.query(
        "UPDATE ha_repo_heads SET revision=65, head_op_id='op-65', head_event_digest='sha256:x', head_digest='sha256:y' WHERE repo_id='summary-upgrade'",
      );
      await backend.pool.query(
        "INSERT INTO ha_projection_meta(tenant_id,project_id,policy_epoch,readers,projection_name,schema_version,watermark,source_revision) VALUES ('t','p',0,'{}','task/v1',5,65,65)",
      );
      // The previous release already completed event v5 but never wrote fleet summaries, and an
      // old database has no readiness row yet.
      await backend.pool.query("UPDATE ha_events SET summary_json=NULL, read_index_version=5");
      await backend.pool.query("DELETE FROM ha_event_summary_state");
      assert.equal((await backend.projection.readEventSummaries(0, 100, "fleet")).events.length, 65);
      const first = (
        await backend.pool.query("SELECT ha_backfill_event_read_indexes('t','p',0,'summary-upgrade') AS processed")
      ).rows[0].processed;
      assert.equal(first, 64);
      assert.equal((await backend.projection.readEventSummaries(0, 100, "fleet")).events.length, 65);
      let processed = first;
      while (processed > 0)
        processed = (
          await backend.pool.query("SELECT ha_backfill_event_read_indexes('t','p',0,'summary-upgrade') AS processed")
        ).rows[0].processed;
      assert.equal(
        (await backend.pool.query("SELECT count(*)::int AS count FROM ha_events WHERE summary_json IS NULL")).rows[0]
          .count,
        0,
      );
      assert.equal((await backend.projection.readEventSummaries(0, 100, "fleet")).events.length, 65);
    } finally {
      await backend.close();
      rmSync(dataDir, { recursive: true, force: true });
    }
  });
});

pgliteIntegrationSuite("fleet summary lifecycle", () => {
  test("cold rebuild restores readiness and fleet reads before and after reopening", async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "ha-fleet-rebuild-")),
      repoId = "fleet-rebuild",
      scope = { tenantId: "t", projectId: "p", policyEpoch: 0, readers: [] },
      storage = { backend: "pglite" as const, dataDir: root, materialize: false, scope };
    let backend = await createPGliteStorageBackend({ repoId, storage });
    try {
      await backend.eventStore.append(bundle(eventAt(1)), 0, { repoId, holderId: "seed", epoch: 1 });
      const before = await backend.projection.readEventSummaries(0, 100, "fleet");
      await withPostgresTransaction(
        backend.pool,
        (client) =>
          rebuildPgProjection(client, scope, {
            events: [eventAt(1)],
            sourceRevision: 1,
          }),
        scope,
      );
      assert.equal(
        (await backend.pool.query("SELECT ready FROM ha_event_summary_state WHERE repo_id=$1", [repoId])).rows[0]
          ?.ready,
        true,
      );
      assert.deepEqual(await backend.projection.readEventSummaries(0, 100, "fleet"), before);
      await backend.close();
      backend = await createPGliteStorageBackend({ repoId, storage });
      assert.deepEqual(await backend.projection.readEventSummaries(0, 100, "fleet"), before);
    } finally {
      await backend.close();
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("migration import publishes fleet readiness on the activated target without reopening", async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "ha-fleet-import-")),
      repoId = "fleet-import",
      scope = { tenantId: "t", projectId: "p", policyEpoch: 0, readers: [] },
      source = await createPGliteStorageBackend({
        repoId,
        storage: { backend: "pglite", dataDir: path.join(root, "source"), scope },
      }),
      target = await createPGliteStorageBackend({
        repoId,
        storage: { backend: "pglite", dataDir: path.join(root, "target"), scope },
      });
    try {
      await source.eventStore.append(bundle(eventAt(1)), 0, { repoId, holderId: "seed", epoch: 1 });
      const before = await source.projection.readEventSummaries(0, 100, "fleet"),
        endpoint = (backend: typeof source, identity: string) =>
          openPgMigrationEndpoint({ pool: backend.pool, repoId, scope, backend: "pglite", identity });
      await migrateStorage({
        repoId,
        runId: "fleet-import",
        source: await endpoint(source, "source"),
        target: await endpoint(target, "target"),
        exportDirectory: path.join(root, "export"),
      });
      assert.equal(
        (await target.pool.query("SELECT ready FROM ha_event_summary_state WHERE repo_id=$1", [repoId])).rows[0]?.ready,
        true,
      );
      assert.deepEqual(await target.projection.readEventSummaries(0, 100, "fleet"), before);
    } finally {
      await source.close();
      await target.close();
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("finishing one scope or repo retains the global pending index until every scope is ready", async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "ha-fleet-scopes-")),
      scope = { tenantId: "t", projectId: "p", policyEpoch: 0, readers: [] },
      backend = await createPGliteStorageBackend({
        repoId: "first",
        storage: { backend: "pglite", dataDir: root, scope },
      }),
      stores = [
        backend,
        createPgStorageBackend({ pool: backend.pool, repoId: "second", scope }),
        createPgStorageBackend({ pool: backend.pool, repoId: "third", scope: { ...scope, tenantId: "other" } }),
      ],
      identities = [
        ["t", "first"],
        ["t", "second"],
        ["other", "third"],
      ];
    const ensure = () =>
        withPostgresTransaction(backend.pool, (client) => ensurePgProjectionSchema(client, { indexBuild: "isolated" })),
      index = async () =>
        (await backend.pool.query("SELECT to_regclass('ha_events_summary_pending')::text AS name")).rows[0].name;
    try {
      for (let i = 0; i < stores.length; i++)
        await stores[i]!.eventStore.append(bundle({ ...eventAt(i + 1), workspaceRevision: 1 }), 0, {
          repoId: identities[i]![1]!,
          holderId: "seed",
          epoch: 1,
        });
      await backend.pool.query("UPDATE ha_events SET summary_json=NULL");
      await backend.pool.query("DELETE FROM ha_event_summary_state");
      await ensure();
      assert.equal(await index(), "ha_events_summary_pending");
      for (let i = 0; i < identities.length; i++) {
        const [tenant, repo] = identities[i]!;
        assert.equal(
          (await backend.pool.query("SELECT ha_backfill_event_read_indexes($1,'p',0,$2) AS processed", [tenant, repo]))
            .rows[0].processed,
          1,
        );
        // The last data page does not certify completion; interrupted callers can resume.
        assert.equal(
          (await backend.pool.query("SELECT ha_backfill_event_read_indexes($1,'p',0,$2) AS processed", [tenant, repo]))
            .rows[0].processed,
          0,
        );
        assert.equal(await index(), "ha_events_summary_pending", "page transactions never perform global DDL");
        if (i === 0) {
          // A manager filtered to the completed scope cannot certify global completion.
          await backend.pool.query("CREATE ROLE summary_index_scope NOBYPASSRLS");
          await backend.pool.query(
            "GRANT SELECT ON ha_events,ha_repo_heads,ha_event_summary_state TO summary_index_scope",
          );
          await withPostgresTransaction(
            backend.pool,
            async (client) => {
              await client.query("SET LOCAL ROLE summary_index_scope");
              assert.equal(await contractPgEventSummaryIndex(client, { indexBuild: "isolated" }), false);
            },
            scope,
          );
          assert.equal(await index(), "ha_events_summary_pending");
        }
        await ensure();
        assert.equal(await index(), i === identities.length - 1 ? null : "ha_events_summary_pending");
      }
      assert.equal((await backend.projection.readEventSummaries(0, 100, "fleet")).events.length, 1);
    } finally {
      await backend.close();
      rmSync(root, { recursive: true, force: true });
    }
  });
});
