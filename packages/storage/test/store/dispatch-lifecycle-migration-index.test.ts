// harness-test-tier: fast
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { legacyDispatchLifecycleMigrationSessions } from "../../src/store/dispatch-lifecycle-migration-index.ts";

test("indexed migration candidates retain terminal outcomes without accepted stop proof", () => {
  const db = new DatabaseSync(":memory:");
  try {
    db.exec(`
      CREATE TABLE runtime_session(runtime_session_id TEXT PRIMARY KEY, value_json TEXT NOT NULL);
      CREATE TABLE dispatch_lifecycle_attempt(runtime_session_id TEXT PRIMARY KEY, attempt_json TEXT NOT NULL);
    `);
    const insertSession = db.prepare("INSERT INTO runtime_session VALUES (?, ?)");
    insertSession.run("session-active", JSON.stringify({ outcome: null }));
    insertSession.run("session-terminal-unproven", JSON.stringify({ outcome: { status: "succeeded" } }));
    insertSession.run("session-stop-proven", JSON.stringify({ outcome: { status: "succeeded" } }));
    db.prepare("INSERT INTO dispatch_lifecycle_attempt VALUES (?, ?)").run(
      "session-stop-proven",
      JSON.stringify({ stopProof: "proven_stopped", capacity: "released" }),
    );

    assert.deepEqual(legacyDispatchLifecycleMigrationSessions(db), ["session-active", "session-terminal-unproven"]);
  } finally {
    db.close();
  }
});
