// harness-test-tier: integration
import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { history, digest } from "./completion-history.fixtures.ts";
import { openSqliteEventStore, sqliteLedgerPath } from "../../src/store/sqlite-event-store.ts";
import { sha256Text, stableStringify } from "../../src/integrity/stable-hash.ts";
import { planCompletionGeneration } from "../../src/store/completion-generation-plan.ts";
import {
  writeCompletionGeneration,
  verifyCompletionGeneration,
  completionConversionStream,
} from "../../src/store/completion-generation-target.ts";
import { makeTaskProjection } from "../../src/projection/rebuildable-task-projection-factory.ts";
import { selectGenerationThree } from "../../src/store/generation-three-selection.ts";

test("offline target preserves missing-snapshot acceptance, every outcome, and exact op replay while remaining unselectable", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "ha-completion-target-"));
  const sourceRoot = path.join(root, "source"),
    targetRoot = path.join(root, "target"),
    repoId = "history-target";
  const initial = openSqliteEventStore({ repoId, rootInput: sourceRoot, generation: 2 });
  initial.close();
  const raw = new DatabaseSync(sqliteLedgerPath(sourceRoot, 2));
  const insert = raw.prepare(
    "INSERT INTO event(revision,op_id,event_json,digest,occurred_at,recorded_at) VALUES(?,?,?,?,?,?)",
  );
  const command = raw.prepare(
    "INSERT INTO command_outcome(op_id,status,first_revision,last_revision,intent_digest,intent_summary,rejection_code,recorded_at) VALUES(?,?,?,?,?,?,?,?)",
  );
  for (const event of history()) {
    const bytes = `${stableStringify(event)}\n`;
    insert.run(
      event.workspaceRevision,
      event.opId,
      bytes,
      `sha256:${sha256Text(bytes)}`,
      event.occurredAt,
      event.occurredAt,
    );
    command.run(
      event.opId,
      "accepted_durable",
      event.workspaceRevision,
      event.workspaceRevision,
      `sha256:${sha256Text(event.opId)}`,
      "original request",
      null,
      event.occurredAt,
    );
  }
  command.run(
    "rejected",
    "rejected",
    null,
    null,
    digest,
    "rejected source request",
    "revision_conflict",
    "2026-09-01T00:00:00.000Z",
  );
  command.run(
    "no-op",
    "accepted_durable",
    null,
    null,
    digest,
    "no-op source request",
    null,
    "2026-09-01T00:00:00.000Z",
  );
  raw.exec("UPDATE ledger_meta SET revision=4");
  raw.close();
  const source = openSqliteEventStore({ repoId, rootInput: sourceRoot, generation: 2, readOnly: true });
  try {
    const plan = planCompletionGeneration(source, new Set([digest]));
    writeCompletionGeneration(source, targetRoot, plan);
    const result = verifyCompletionGeneration(source, targetRoot, plan);
    assert.equal(result.events, 4);
    assert.equal(result.commandOutcomes, 6);
    assert.throws(() => selectGenerationThree({ rootInput: targetRoot, repoId }), /upgrade is incomplete/);
    const target = openSqliteEventStore({ repoId, rootInput: targetRoot, generation: 3 });
    const projection = makeTaskProjection({ rootDir: targetRoot, eventStore: completionConversionStream(target) });
    try {
      projection.rebuild();
      const state = projection.read("task-history").snapshot;
      assert.equal(state.task?.status, "done");
      assert.equal(state.executions[0]?.state, "accepted");
      assert.equal(state.task?.presetSnapshotGap?.reason, "snapshot-bytes-unavailable");
      assert.deepEqual(state.gateWitnesses, []);
      assert.equal(target.contentObjectDigests().length, 0);
      const original = source.outcome("op-2")!;
      const fence = { repoId, holder: "new-writer", epoch: 3 };
      target.claimWriter(fence);
      const replay = target.appendCommand({
        fence,
        intent: { opId: original.opId, intentDigest: original.intentDigest, summary: original.summary },
        events: [],
      });
      assert.deepEqual(replay, original);
      assert.equal(target.revision(), 4);
      assert.throws(
        () =>
          target.appendCommand({
            fence,
            intent: { opId: original.opId, intentDigest: digest, summary: original.summary },
            events: [],
          }),
        /another command intent/,
      );
      assert.equal(target.revision(), 4);
    } finally {
      projection.close();
      target.close();
    }
  } finally {
    source.close();
    rmSync(root, { recursive: true, force: true });
  }
});
