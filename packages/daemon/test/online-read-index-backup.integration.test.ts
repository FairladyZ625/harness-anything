// harness-test-tier: integration
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import path from "node:path";
import test from "node:test";
import * as tar from "tar";
import { resolveHarnessLayout } from "@harness-anything/kernel";
import { makeTaskProjection, makeTaskProjectionReader, startBaseBackup } from "@harness-anything/storage";
import { BASE_BACKUP_ARCHIVE_ROOT } from "../../storage/src/fleet-basebackup-layout.ts";
import { sqliteLedgerPath } from "../../storage/src/store/sqlite-ledger-layout.ts";
import { withTempStoreAsync } from "../../storage/test/store/helpers.ts";
import { repositoryEventQueries as previousQueries } from "../../storage/test/store/previous-runtime-reader/repository-event-queries.fixture.ts";
import { ensureRuntimeMemberIndex as ensurePrevious } from "../../storage/test/store/previous-runtime-reader/runtime-member-index.fixture.ts";
import { canonicalRoot, workspaceId } from "../src/protocol/daemon-protocol.contract.ts";
import { openBootstrappedRepoCell } from "./repo-settings.fixture.ts";
import { seedLegacyReadIndexEvents } from "./online-read-index.fixture.ts";

test("basebackup completes the shared migration on its private copy for a previous reader", async () => {
  await withTempStoreAsync(async (rootDir) => {
    execFileSync("git", ["init", "-q", rootDir]);
    await (
      await openBootstrappedRepoCell({
        rootDir: canonicalRoot(rootDir),
        repoId: workspaceId("compat-backup"),
        ownerId: "fixture",
      })
    ).close();
    const head = seedLegacyReadIndexEvents(rootDir, 130, false, "agent"),
      projectionPath = resolveHarnessLayout(rootDir).taskProjectionPath,
      cache = new DatabaseSync(projectionPath),
      eventDigest = String(
        cache.prepare("SELECT head_digest FROM projection_meta").get()!.head_digest,
      ) as `sha256:${string}`;
    try {
      // A pre-expansion cache can have none of the legacy column indexes. Keep existing base
      // indexes: this regression must exercise empty shadow indexes, not native history builds.
      for (const row of cache
        .prepare(
          "SELECT name FROM sqlite_master WHERE type='index' AND (name LIKE 'event_index_runtime_member_%' OR name LIKE 'event_index_runtime_dispatch_key%')",
        )
        .all())
        cache.exec(`DROP INDEX ${row.name}`);
      for (const row of cache
        .prepare("SELECT name FROM sqlite_master WHERE type='trigger' AND name LIKE 'runtime_dispatch_%'")
        .all())
        cache.exec(`DROP TRIGGER ${row.name}`);
      cache.exec("UPDATE event_index SET runtime_session_present=NULL,dispatch_key=NULL");
    } finally {
      cache.close();
    }
    const projection = makeTaskProjection({
      rootDir,
      projectionPath,
      eventStore: {
        readHead: () => ({ revision: head, eventDigest }),
        readBatch: () => ({ sourceRevision: head, events: [], cursor: null, done: true, accessedItems: 0 }),
        readContentBlob: () => null,
      },
    });
    assert.equal(projection.readCut().status, "ready");
    projection.close();
    const before = new DatabaseSync(projectionPath, { readOnly: true }),
      live = makeTaskProjectionReader({ rootDir, projectionPath });
    try {
      assert.equal(before.prepare("SELECT revision FROM runtime_read_index_progress").get()!.revision, 0);
      const job = await startBaseBackup({
        ledgerPath: sqliteLedgerPath(rootDir),
        projectionPath,
        directory: path.join(rootDir, "backup"),
      });
      assert.equal(job.metadata.position.revision, head);
      assert.equal(
        live.withSession((q) => q.readRuntimeDispatchByDispatchKey("key-130"))?.event.payload.dispatchId,
        "dispatch-130",
      );
      const archive = await job.complete,
        unpacked = path.join(rootDir, "unpacked");
      mkdirSync(unpacked);
      await tar.x({ file: archive.file, cwd: unpacked });
      // The backup's work never advances the live center cursor or publishes its shadow table.
      assert.equal(before.prepare("SELECT revision FROM runtime_read_index_progress").get()!.revision, 0);
      assert.ok(before.prepare("SELECT 1 FROM sqlite_master WHERE name='runtime_event_index_compat'").get());
      const replicaPath = path.join(unpacked, BASE_BACKUP_ARCHIVE_ROOT, "cache", "task.sqlite"),
        old = new DatabaseSync(replicaPath, { readOnly: true }),
        q = previousQueries((read) => read(old, { status: "ready", watermark: head, sourceRevision: head }));
      try {
        assert.deepEqual(
          old
            .prepare("SELECT op_id,workspace_revision,task_id,event_json FROM event_index ORDER BY workspace_revision")
            .all(),
          before
            .prepare("SELECT op_id,workspace_revision,task_id,event_json FROM event_index ORDER BY workspace_revision")
            .all(),
          "copying preserves every canonical projection field at the pinned cut",
        );
        assert.equal(old.prepare("SELECT complete FROM runtime_read_index_progress").get()!.complete, 1);
        assert.equal(
          old.prepare("SELECT 1 FROM sqlite_master WHERE name='runtime_event_index_compat'").get(),
          undefined,
        );
        assert.equal(q.readRuntimeDispatchByDispatchKey("key-130")?.event.payload.dispatchId, "dispatch-130");
        assert.equal(q.readRuntimeDispatchesByMember({ agentId: "agent", limit: 10 }).rows.length, 1);
        const writer = new DatabaseSync(replicaPath);
        try {
          // The previous apply code reopens the transferred cache and inserts its original four
          // columns. Its existing trigger names continue to maintain the required physical fields.
          ensurePrevious(writer);
          const row = JSON.parse(
            String(writer.prepare("SELECT event_json FROM event_index WHERE op_id='dispatch-130'").get()!.event_json),
          );
          row.opId = "dispatch-after";
          row.eventId = "event-after";
          row.workspaceRevision = head + 1;
          row.payload.dispatchId = "dispatch-after";
          row.payload.dispatchKey = "key-after";
          writer
            .prepare("INSERT INTO event_index(op_id,workspace_revision,event_json) VALUES(?,?,?)")
            .run(row.opId, head + 1, JSON.stringify(row));
          assert.equal(q.readRuntimeDispatchByDispatchKey("key-after")?.event.payload.dispatchId, "dispatch-after");
          writer.exec("INSERT INTO runtime_session VALUES('session-130',999,'{}','')");
          assert.equal(q.readRuntimeDispatchesByMember({ agentId: "agent", limit: 10 }).sessions.length, 1);
          writer.exec("DELETE FROM runtime_session WHERE runtime_session_id='session-130'");
          assert.equal(q.readRuntimeDispatchesByMember({ agentId: "agent", limit: 10 }).sessions.length, 0);
        } finally {
          writer.close();
        }
      } finally {
        old.close();
      }
    } finally {
      live.close();
      before.close();
    }
  });
});
