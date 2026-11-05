// harness-test-tier: integration
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { EventEmitter, once } from "node:events";
import { execFileSync } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { resolveHarnessLayout } from "@harness-anything/kernel";
import { validateCurrentAgentRuntimeEvent } from "@harness-anything/kernel/internal/domain/agent-runtime.ts";
import { makeTaskProjectionReader } from "@harness-anything/storage";
import { sqliteLedgerPath } from "../../storage/src/store/sqlite-ledger-layout.ts";
import { withTempStoreAsync } from "../../storage/test/store/helpers.ts";
import { openBootstrappedRepoCell } from "./repo-settings.fixture.ts";
import { canonicalRoot, workspaceId } from "../src/protocol/daemon-protocol.contract.ts";

test("100000-event populated cache attaches before read-index backfill and continues serving reads", async (t) => {
  await withTempStoreAsync(async (rootDir) => {
    execFileSync("git", ["init", "-q", rootDir]);
    const progress = new EventEmitter();
    const input = {
      rootDir: canonicalRoot(rootDir),
      repoId: workspaceId("online-attach"),
      ownerId: "online-attach",
      onStatus: () => {
        progress.emit("page");
      },
    };
    let cell = await openBootstrappedRepoCell(input);
    await cell.close();
    const projectionPath = resolveHarnessLayout(rootDir).taskProjectionPath,
      db = new DatabaseSync(sqliteLedgerPath(rootDir));
    db.exec("ATTACH DATABASE '" + projectionPath.replaceAll("'", "''") + "' AS cache");
    let head = Number(db.prepare("SELECT revision FROM ledger_meta").get()!.revision);
    let digest = "";
    try {
      // Populate an already caught-up canonical ledger/cache. Only the newly introduced column
      // is removed; this isolates schema expansion from an unrelated cold canonical replay.
      db.exec(`DROP TRIGGER cache.runtime_dispatch_key_0; DROP TRIGGER cache.runtime_dispatch_key_1;
        DROP INDEX cache.event_index_runtime_dispatch_key; DROP INDEX cache.event_index_runtime_dispatch_key_pending;
        ALTER TABLE cache.event_index DROP COLUMN dispatch_key; DROP TABLE cache.runtime_read_index_progress; BEGIN`);
      const canonical = db.prepare("INSERT INTO event(revision,op_id,event_json,digest,occurred_at) VALUES(?,?,?,?,?)"),
        projected = db.prepare("INSERT INTO cache.event_index(op_id,workspace_revision,event_json) VALUES(?,?,?)"),
        source = db.prepare("INSERT INTO cache.event_source(workspace_revision,op_id,event_json) VALUES(?,?,?)");
      for (let n = 1; n <= 100000; n++) {
        const event = {
          schema: "agent-runtime-event/v1",
          type: "runtime_dispatch_requested",
          eventId: `dispatch-${n}`,
          opId: `dispatch-${n}`,
          workspaceRevision: ++head,
          actor: { principal: { personId: "fixture" }, executor: null },
          source: "local",
          occurredAt: "2026-11-05T00:00:00.000Z",
          payload: {
            dispatchId: `dispatch-${n}`,
            runtimeSessionId: `session-${n}`,
            instanceId: "fixture",
            installationId: "installation",
            kindId: "claude",
            dispatchKey: `key-${n}`,
            definitionSnapshotRef: "artifact:runtime-definitions/fixture/v1",
            definitionSnapshot: {
              schema: "agent-definition-snapshot/v1",
              configVersion: 1,
              instanceId: "fixture",
              installationId: "installation",
              kindId: "claude",
              providerId: "anthropic",
              model: "fixture",
              reasoningEffort: null,
              baseUrl: null,
              authMode: "subscription",
            },
          },
        };
        if (n === 1) assert.deepEqual(validateCurrentAgentRuntimeEvent(event), []);
        const json = JSON.stringify(event);
        digest = `sha256:${createHash("sha256").update(json).digest("hex")}`;
        canonical.run(head, event.opId, json, digest, event.occurredAt);
        projected.run(event.opId, head, json);
        source.run(head, event.opId, json);
      }
      db.prepare("UPDATE ledger_meta SET revision=?").run(head);
      for (const table of ["event_query_meta", "document_head_meta", "attach_migration_scan_meta"])
        db.prepare(`UPDATE ${table} SET revision=?`).run(head);
      db.prepare("UPDATE cache.projection_meta SET watermark=?,scanned_revision=?,head_digest=?").run(
        head,
        head,
        digest,
      );
      db.exec("COMMIT; DETACH DATABASE cache");
    } finally {
      db.close();
    }
    const start = performance.now();
    cell = await openBootstrappedRepoCell(input);
    const attachMs = performance.now() - start,
      inspect = new DatabaseSync(projectionPath, { readOnly: true }),
      reader = makeTaskProjectionReader({ rootDir });
    try {
      assert.equal(cell.status().state, "attached");
      const pendingAtAttach = Number(
        inspect.prepare("SELECT count(*) AS n FROM event_index WHERE dispatch_key IS NULL").get()!.n,
      );
      assert.ok(pendingAtAttach > 0, "attach consumed the historical migration");
      assert.ok(attachMs < 5000, `attach took ${attachMs}ms`);
      const readStart = performance.now();
      assert.equal(
        reader.withSession((q) => q.readRuntimeDispatchByDispatchKey("key-100000"))?.event.payload.dispatchId,
        "dispatch-100000",
      );
      const readMs = performance.now() - readStart;
      // Wait on durable progress, with bounded event-loop turns, never a wall-clock sleep.
      for (let turn = 0; turn < 5000; turn++) {
        if (inspect.prepare("SELECT complete FROM runtime_read_index_progress").get()!.complete === 1) break;
        await once(progress, "page", { signal: AbortSignal.timeout(30000) });
      }
      assert.equal(inspect.prepare("SELECT complete FROM runtime_read_index_progress").get()!.complete, 1);
      assert.equal(
        reader.withSession((q) => q.readRuntimeDispatchByDispatchKey("key-100000"))?.event.payload.dispatchId,
        "dispatch-100000",
      );
      t.diagnostic(`ONLINE_ATTACH ${JSON.stringify({ events: head, attachMs, pendingAtAttach, readMs })}`);
    } finally {
      reader.close();
      inspect.close();
      await cell.close();
    }
  });
});
