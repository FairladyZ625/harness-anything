// harness-test-tier: integration
// Prototype only: process crashes and exact outcome/event recovery, not power loss or daemon receipts.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { openSqliteEventStore } from "../../packages/kernel/src/store/sqlite-event-store.ts";
import { command, repoId } from "./sqlite-boundary-child.mjs";

function rows(databasePath) {
  const db = new DatabaseSync(databasePath, { readOnly: true });
  try {
    return {
      integrity: db.prepare("PRAGMA integrity_check").all(),
      head: Number(db.prepare("SELECT revision FROM ledger_meta").get().revision),
      events: db
        .prepare("SELECT event_json FROM event ORDER BY revision")
        .all()
        .map((r) => JSON.parse(r.event_json)),
      outcomes: db.prepare("SELECT * FROM command_outcome ORDER BY op_id").all(),
      writers: db.prepare("SELECT holder, epoch FROM writer_lease").all(),
    };
  } finally {
    db.close();
  }
}

function assertCommitted(cut, input) {
  assert.equal(cut.head, 3);
  assert.deepEqual(cut.events, input.events);
  assert.equal(cut.outcomes.length, 1);
  assert.equal(cut.outcomes[0].op_id, input.intent.opId);
  assert.equal(cut.outcomes[0].intent_digest, input.intent.intentDigest);
  assert.equal(cut.outcomes[0].first_revision, 1);
  assert.equal(cut.outcomes[0].last_revision, 3);
  assert.equal(cut.outcomes[0].status, "accepted_durable");
  assert.deepEqual(
    cut.writers.map((r) => ({ ...r })),
    [{ holder: "successor", epoch: 2 }],
  );
}

for (const boundary of ["before-outcome", "after-commit", "after-receipt"]) {
  test(
    `prototype recovers an exact command after SIGKILL at ${boundary}`,
    {
      skip: process.platform === "win32" ? "requires POSIX SIGKILL semantics" : false,
    },
    (context) => {
      const scratch = mkdtempSync(path.join(tmpdir(), "ha-stress-boundary-"));
      const databasePath = path.join(scratch, "ledger.sqlite");
      const input = command();
      let store;
      try {
        store = openSqliteEventStore({ repoId, databasePath });
        store.claimWriter({ repoId, holder: "original", epoch: 1 });
        store.close();
        store = undefined;
        const killed = spawnSync(
          process.execPath,
          [path.join(import.meta.dirname, "sqlite-boundary-child.mjs"), databasePath, boundary],
          { encoding: "utf8", timeout: 15_000 },
        );
        assert.equal(killed.error, undefined);
        assert.equal(killed.signal, "SIGKILL", killed.stderr);
        const observed = JSON.parse(killed.stdout.trim());
        assert.equal(observed.boundary, boundary);
        const recovered = rows(databasePath);
        assert.equal(recovered.integrity.length, 1);
        assert.equal(recovered.integrity[0].integrity_check, "ok");
        if (boundary === "before-outcome") {
          assert.equal(recovered.head, 0);
          assert.deepEqual(recovered.events, []);
          assert.deepEqual(recovered.outcomes, []);
          assert.deepEqual(
            recovered.writers.map((r) => ({ ...r })),
            [{ holder: "original", epoch: 1 }],
          );
        } else {
          assertCommitted(recovered, input);
          // Broken recovery cuts must fail even when the head/count still look right.
          assert.throws(() => assertCommitted({ ...recovered, outcomes: [] }, input), assert.AssertionError);
          assert.throws(
            () => assertCommitted({ ...recovered, events: [...recovered.events].reverse() }, input),
            assert.AssertionError,
          );
        }
        store = openSqliteEventStore({ repoId, databasePath });
        const first = store.appendCommand(input);
        if (boundary === "after-receipt") assert.deepEqual(first, observed.outcome);
        assert.deepEqual(store.appendCommand(input), first);
        assert.throws(
          () =>
            store.appendCommand({
              ...input,
              intent: { ...input.intent, intentDigest: `sha256:${"f".repeat(64)}` },
            }),
          /another command intent/u,
        );
        assert.deepEqual(store.appendCommand(input), first);
        assertCommitted(rows(databasePath), input);
        context.diagnostic(
          JSON.stringify({
            schema: "sqlite-boundary-prototype/v1",
            boundary,
            clientReceiptObserved: Boolean(observed.outcome),
            recoveredEvents: recovered.events.length,
            recoveredOutcomes: recovered.outcomes.length,
            finalEvents: 3,
            signal: killed.signal,
            sqliteVersion: store.sqliteVersion,
            platform: process.platform,
            scope: "process-crash-only; blobs, logs, daemon, power-loss unverified",
          }),
        );
      } finally {
        store?.close();
        rmSync(scratch, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
      }
    },
  );
}
