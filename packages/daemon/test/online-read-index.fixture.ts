import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { resolveHarnessLayout } from "@harness-anything/kernel";
import { validateCurrentAgentRuntimeEvent } from "@harness-anything/kernel/internal/domain/agent-runtime.ts";
import { sqliteLedgerPath } from "../../storage/src/store/sqlite-ledger-layout.ts";

export function seedLegacyReadIndexEvents(
  rootDir: string,
  count: number,
  injectFailure = false,
  lastDispatchAgentId?: string,
): number {
  const projectionPath = resolveHarnessLayout(rootDir).taskProjectionPath,
    db = new DatabaseSync(sqliteLedgerPath(rootDir));
  db.exec("ATTACH DATABASE '" + projectionPath.replaceAll("'", "''") + "' AS cache");
  let head = Number(db.prepare("SELECT revision FROM ledger_meta").get()!.revision);
  let digest = "";
  try {
    // Populate an already caught-up canonical ledger/cache. Remove only this migration's
    // derived state, leaving previous indexes intact; expansion must not include a cold replay.
    db.exec(`DROP TRIGGER cache.runtime_read_index_event_0; DROP TRIGGER cache.runtime_read_index_event_1;
        DROP TRIGGER cache.runtime_read_index_event_delete; DROP TRIGGER cache.runtime_read_index_session_present;
        DROP TRIGGER cache.runtime_read_index_session_absent; DROP TABLE cache.runtime_dispatch_index;
        UPDATE cache.runtime_read_index_progress SET revision=0,complete=0; BEGIN`);
    const canonical = db.prepare("INSERT INTO event(revision,op_id,event_json,digest,occurred_at) VALUES(?,?,?,?,?)"),
      projected = db.prepare("INSERT INTO cache.event_index(op_id,workspace_revision,event_json) VALUES(?,?,?)"),
      source = db.prepare("INSERT INTO cache.event_source(workspace_revision,op_id,event_json) VALUES(?,?,?)");
    for (let n = 1; n <= count; n++) {
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
          ...(n === count && lastDispatchAgentId ? { agentId: lastDispatchAgentId } : {}),
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
    // These valid dispatch events change none of the existing document/declaration indexes.
    // Keep every pre-existing index at the canonical head; otherwise this fixture measures an
    // unrelated entity-declaration replay (two SQL statements per seeded event) during attach.
    for (const table of [
      "event_query_meta",
      "document_head_meta",
      "attach_migration_scan_meta",
      "entity_declaration_meta",
    ])
      db.prepare(`UPDATE ${table} SET revision=?`).run(head);
    db.prepare("UPDATE cache.projection_meta SET watermark=?,scanned_revision=?,head_digest=?").run(head, head, digest);
    if (injectFailure)
      db.exec(`CREATE TRIGGER cache.inject_backfill_failure BEFORE UPDATE OF revision ON runtime_read_index_progress
        WHEN OLD.revision=64 AND NEW.revision>64 BEGIN SELECT RAISE(ABORT,'injected read-index page failure'); END`);
    db.exec("COMMIT; DETACH DATABASE cache");
  } finally {
    db.close();
  }
  return head;
}
