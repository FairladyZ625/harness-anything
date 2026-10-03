// harness-test-tier: integration
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { makeTaskEventReader, makeTaskEventStore } from "../../src/store/task-event-store-factory.ts";
import { openSqliteEventStore, sqliteLedgerPath, sqliteContentObjectPath } from "../../src/store/sqlite-event-store.ts";
import { makeTaskProjection } from "../../src/projection/rebuildable-task-projection.ts";
import { parseCanonicalEvent, serializeCanonicalEventUnchecked } from "../../src/domain/doc-sync-canonical-events.ts";
import { taskBootstrapWritePlan } from "../../src/domain/task-bootstrap-event.ts";
import { deriveRelationId } from "../../src/domain/entity-relation.ts";
import { sha256Text, stableStringify } from "../../src/integrity/stable-hash.ts";
import { initRepo } from "./task-event-store.fixtures.ts";

function fixture(schema: string, name = "accepted.json") {
  return JSON.parse(
    readFileSync(new URL(`../../fixtures/canonical-events/${schema}/${name}`, import.meta.url), "utf8"),
  );
}

test("cold generation2 replay preserves historical bootstrap, execution, documents and relation bytes", async () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "ha-historical-source-"));
  const source = { kind: "assignment", assignmentId: "fixture-assignment", nodeId: "fixture-node" };
  const bootstrap = fixture("task-bootstrap-event-v1");
  const started = fixture("task-event-v1", "accepted-execution-started-79f70e21711f.json");
  const relation = fixture("relation-event-v1");
  const snapshotValue = { schema: "preset-snapshot/v1", id: "fixture-preset" };
  const digest = `sha256:${sha256Text(stableStringify(snapshotValue))}`;
  const snapshotBody = stableStringify({ ...snapshotValue, digest }) + "\n";
  const documentBody = "# Preserved historical plan\n";
  const packagePath = `tasks/${bootstrap.taskId}-fixture`;
  bootstrap.payload.task.presetSnapshotDigest = digest;
  bootstrap.payload.presetSnapshotClaim = {
    digest,
    sha256: sha256Text(snapshotBody),
    size: Buffer.byteLength(snapshotBody),
    mediaType: "application/json",
  };
  bootstrap.payload.initialDocumentClaims = [
    {
      path: `${packagePath}/task_plan.md`,
      sha256: sha256Text(documentBody),
      size: Buffer.byteLength(documentBody),
      mediaType: "text/markdown",
      owner: "doc-sync",
      policyId: "markdown-body-replaceable/v1",
    },
  ];
  started.taskId = bootstrap.taskId;
  started.payload.task = { ...bootstrap.payload.task, status: "active" };
  started.payload.execution.taskId = bootstrap.taskId;
  started.payload.lease.taskId = bootstrap.taskId;
  started.payload.lease.source = source;
  started.payload.previousHolder.taskId = bootstrap.taskId;
  started.payload.previousHolder.source = source;
  // Document bodies are represented by the bootstrap claims for this isolated replay fixture.
  started.payload.documentClaims = [];
  const record = relation.payload.relation;
  record.source = `execution/${started.payload.execution.executionId}`;
  record.target = `task/${bootstrap.taskId}`;
  record.type = "relates";
  record.targetObservedVersion = 2;
  record.relation_id = deriveRelationId(record);
  relation.relationId = record.relation_id;
  const events = [bootstrap, started, relation].map((event, index) => ({
    ...event,
    source,
    workspaceRevision: index + 1,
  }));
  let reader: ReturnType<typeof makeTaskEventReader> | undefined;
  let projection: ReturnType<typeof makeTaskProjection> | undefined;
  try {
    initRepo(rootDir);
    const databasePath = sqliteLedgerPath(rootDir, 2);
    // Build a stopped, sanitized historical fixture. No live writer or production ledger is used.
    const empty = openSqliteEventStore({ rootInput: rootDir, repoId: "historical-fixture", generation: 2 });
    empty.close();
    const db = new DatabaseSync(databasePath);
    try {
      const insert = db.prepare(
        "INSERT INTO event(revision, op_id, event_json, digest, occurred_at, recorded_at) VALUES(?,?,?,?,?,?)",
      );
      for (const event of events) {
        const body = serializeCanonicalEventUnchecked(event);
        insert.run(
          event.workspaceRevision,
          event.opId,
          body,
          `sha256:${sha256Text(body)}`,
          event.occurredAt,
          event.occurredAt,
        );
      }
      db.prepare("UPDATE ledger_meta SET revision=? WHERE singleton=1").run(events.length);
    } finally {
      db.close();
    }
    for (const body of [snapshotBody, documentBody]) {
      const objectPath = sqliteContentObjectPath(rootDir, sha256Text(body), 2);
      mkdirSync(path.dirname(objectPath), { recursive: true });
      writeFileSync(objectPath, body);
    }
    const before = readFileSync(databasePath);
    const bodies = events.map(serializeCanonicalEventUnchecked);
    reader = makeTaskEventReader({ rootDir, repoId: "historical-fixture", generation: 2 });
    assert.equal(reader.read().revision, 3);
    for (const event of reader.read().events)
      assert.deepEqual(parseCanonicalEvent(bodies[event.workspaceRevision - 1]!), event);
    projection = makeTaskProjection({ rootDir, eventStore: reader });
    projection.rebuild();
    const state = projection.read(bootstrap.taskId);
    assert.deepEqual(state.snapshot.task, started.payload.task);
    assert.deepEqual(state.snapshot.executions[0], started.payload.execution);
    assert.deepEqual(state.snapshot.lease?.source, source);
    assert.equal(state.packagePath, packagePath);
    assert.equal(projection.readDocument(`${packagePath}/task_plan.md`).document?.body, documentBody);
    assert.deepEqual(projection.readPresetSnapshot(digest as `sha256:${string}`).snapshot, JSON.parse(snapshotBody));
    const edge = projection.readRelationEdge(record.relation_id);
    assert.equal(edge?.sourceRef, record.source);
    assert.equal(edge?.targetRef, record.target);
    assert.equal(edge?.relationType, "relates");
    assert.deepEqual(edge?.entity.provenance.source, source);
    projection.close();
    projection = undefined;
    await reader.drain();
    reader = undefined;
    assert.deepEqual(readFileSync(databasePath), before, "read-only replay must preserve the entire ledger");
    // A mutable reopen may rebuild query indexes; event bytes and digests must still remain exact.
    const writer = makeTaskEventStore({
      rootDir,
      repoId: "historical-fixture",
      generation: 2,
      activationPreflight: () => {},
    });
    try {
      assert.throws(
        () => writer.append({ event: events[0], plan: taskBootstrapWritePlan(events[0]), blobs: [] }),
        /current event shape/u,
      );
    } finally {
      await writer.drain();
    }
    const reopened = openSqliteEventStore({
      databasePath,
      repoId: "historical-fixture",
      generation: 2,
      readOnly: true,
    });
    try {
      assert.deepEqual(
        reopened.eventRows().map((row) => row.eventJson),
        bodies,
      );
      assert.deepEqual(
        reopened.eventRows().map((row) => row.digest),
        bodies.map((body) => `sha256:${sha256Text(body)}`),
      );
    } finally {
      reopened.close();
    }
  } finally {
    projection?.close();
    await reader?.drain();
    rmSync(rootDir, { recursive: true, force: true });
  }
});
