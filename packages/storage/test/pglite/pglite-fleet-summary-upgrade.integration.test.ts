// harness-test-tier: integration
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createPGliteStorageBackend } from "../../src/pglite/storage-backend.ts";
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
        "INSERT INTO ha_repo_heads(tenant_id,project_id,repo_id,revision,policy_epoch) VALUES ('t','p','summary-upgrade',0,0)",
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
      await assert.rejects(
        () => backend.projection.readEventSummaries(0, 100, "fleet"),
        /fleet event summaries are not backfilled/u,
      );
      const first = (
        await backend.pool.query("SELECT ha_backfill_event_read_indexes('t','p',0,'summary-upgrade') AS processed")
      ).rows[0].processed;
      assert.equal(first, 64);
      await assert.rejects(
        () => backend.projection.readEventSummaries(0, 100, "fleet"),
        /fleet event summaries are not backfilled/u,
      );
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
