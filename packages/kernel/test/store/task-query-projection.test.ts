// harness-test-tier: integration
import assert from "node:assert/strict";
import test from "node:test";
import { makeTaskProjection } from "../../src/projection/rebuildable-task-projection.ts";
import { createFactProjectionTables, searchFactRows, searchFactRowsPage, readFactAnchorRows, type FactProjectionRow } from "../../src/projection/fact-event-projection.ts";
import { deriveRelationId, type EntityRelationRecord } from "../../src/domain/entity-relation.ts";
import { createRelationGraphProjectionTables } from "../../src/projection/relation-graph-projection.ts";
import { REPLAY_TASK_GRAPH } from "../../src/domain/task-graph.ts";
import type { CanonicalEventV1 } from "../../src/domain/doc-sync.contract.ts";
import type { TaskEventV1 } from "../../src/domain/task-lifecycle.contract.ts";
import type { TaskV1 } from "../../src/domain/task.ts";
import { serializeCanonicalEvent } from "../../src/domain/doc-sync.contract.ts";
import { sha256Text } from "../../src/integrity/stable-hash.ts";
import { withTempStoreAsync } from "./helpers.ts";
import { DatabaseSync } from "node:sqlite";

const actor = { principal: { personId: "person-query" }, executor: null } as const;

/** In-memory canonical event stream: the same port shape the git-backed store exposes, so the
 * projection's real cold catch-up (batching, prefetch, drain) runs against synthetic events. */
function memoryEventStore(events: readonly CanonicalEventV1[]) {
  return {
    readHead: () => events.length === 0 ? null : { revision: events.length, eventDigest: `sha256:${sha256Text(serializeCanonicalEvent(events.at(-1)!))}` },
    readBatch: (cursor: string | null, maxItems: number) => { const start = cursor === null ? 0 : Number(cursor), slice = events.slice(start, start + maxItems); return { sourceRevision: events.length, events: slice, cursor: start + slice.length >= events.length ? null : String(start + slice.length), done: start + slice.length >= events.length, accessedItems: slice.length, prefetchContent: () => new Map<string, Uint8Array | null>() }; },
    readContentBlob: () => null
  };
}

interface Fixture { readonly events: readonly TaskEventV1[]; readonly tasks: readonly TaskV1[] }

/** 6 tasks across statuses and update times; task 2 and 4 own depends-on relations. */
function taskFixture(): Fixture {
  const events: TaskEventV1[] = [];
  let revision = 0;
  const statuses = ["planned", "active", "active", "blocked", "done", "planned"] as const;
  const tasks: TaskV1[] = [];
  for (let index = 0; index < statuses.length; index += 1) {
    const taskId = `task_query_${String(index).padStart(2, "0")}`, base: TaskV1 = { schema: "task/v1", taskId, title: `Query ${index}`, taskClass: "standard", status: "planned", graph: REPLAY_TASK_GRAPH, currentNode: "implementation", iteration: 0, createdBy: actor, completionGateIds: [], presetSnapshotDigest: null };
    revision += 1;
    events.push(envelope(base, revision, `task_created`, { task: base }, `2026-08-1${index}T00:00:00.000Z`));
    if (statuses[index] !== "planned") { revision += 1; const transitioned = { ...base, status: statuses[index] }; events.push(envelope(base, revision, "task_transitioned", { task: transitioned, mutation: { command: "transition" as const, reason: "fixture status", fields: ["status"] }, documentClaims: [] }, `2026-08-2${index}T00:00:00.000Z`)); tasks.push(transitioned); } else tasks.push(base);
  }
  for (const [source, target] of [["task_query_02", "task_query_03"], ["task_query_04", "task_query_05"]] as const) {
    const owner = tasks.find((task) => task.taskId === source)!, basis = { source: `task/${source}`, target: `task/${target}`, type: "depends-on" as const, direction: "directed" as const }, relation: EntityRelationRecord = { relation_id: deriveRelationId(basis), ...basis, strength: "strong", origin: "declared", rationale: "fixture dependency", state: "active" }, related = { ...owner, relations: [...(owner.relations ?? []), relation] };
    revision += 1;
    events.push(envelope(owner, revision, "task_relation_added", { task: related, mutation: { command: "relate" as const, reason: relation.rationale, fields: [relation.relation_id] }, documentClaims: [] }, "2026-08-25T00:00:00.000Z"));
    tasks[tasks.indexOf(owner)] = related;
  }
  return { events, tasks };
}

function envelope(task: TaskV1, revision: number, type: TaskEventV1["type"], payload: Record<string, unknown>, occurredAt: string): TaskEventV1 {
  return { schema: "task-event/v1", eventId: `event-${revision}`, workspaceRevision: revision, opId: `op-${type}-${revision}`, taskId: task.taskId, type, actor, source: "local", occurredAt, payload: payload as never } as TaskEventV1;
}

test("narrow task list pages concatenate to the unparameterized result and keep it byte-identical", async () => {
  const fixture = taskFixture();
  await withTempStoreAsync(async (rootDir) => {
    const projection = makeTaskProjection({ rootDir, eventStore: memoryEventStore(fixture.events) });
    const full = projection.list();
    assert.equal(full.rows.length, 6);
    assert.equal(full.page, undefined);
    // First page of 2, then follow cursors to exhaustion.
    let page = projection.list({ limit: 2 }), rows = [...page.rows];
    while (page.page?.nextCursor) { page = projection.list({ limit: 2, cursor: page.page.nextCursor }); rows = [...rows, ...page.rows]; }
    assert.equal(page.page?.nextCursor, null);
    assert.deepEqual(rows.map(({ taskId, snapshot, updatedAt }) => ({ taskId, status: snapshot.task?.status, updatedAt })), full.rows.map(({ taskId, snapshot, updatedAt }) => ({ taskId, status: snapshot.task?.status, updatedAt })));
    assert.deepEqual(JSON.stringify(rows), JSON.stringify(full.rows), "paged rows must serialize identically to the unparameterized rows");
    // Status filter equals the post-filter over the full read.
    for (const status of ["planned", "active", "blocked", "done"] as const) {
      assert.deepEqual(projection.list({ status }).rows.map((row) => row.taskId), full.rows.filter((row) => row.snapshot.task?.status === status).map((row) => row.taskId));
    }
    // Time windows filter on the update timestamp with inclusive bounds.
    assert.deepEqual(projection.list({ updatedAfter: "2026-08-20T00:00:00.000Z" }).rows.map((row) => row.taskId), full.rows.filter((row) => row.updatedAt >= "2026-08-20T00:00:00.000Z").map((row) => row.taskId));
    assert.deepEqual(projection.list({ updatedAfter: "2026-08-14T00:00:00.000Z", updatedBefore: "2026-08-20T00:00:00.000Z" }).rows.map((row) => row.taskId), full.rows.filter((row) => row.updatedAt >= "2026-08-14T00:00:00.000Z" && row.updatedAt <= "2026-08-20T00:00:00.000Z").map((row) => row.taskId));
    assert.deepEqual(projection.list({ status: "active", limit: 1 }).rows.map((row) => row.taskId), ["task_query_01"]);
  });
});

test("task runtime batch reads up to 500 ids without a variable SQLite IN list", async () => {
  const fixture = taskFixture();
  await withTempStoreAsync(async (rootDir) => {
    const projection = makeTaskProjection({ rootDir, eventStore: memoryEventStore(fixture.events) }), requested = [...fixture.tasks.map(({ taskId }) => taskId), ...Array.from({ length: 494 }, (_, index) => `task_missing_${String(index).padStart(3, "0")}`)];
    const batch = projection.readTaskRuntimeBatch({ taskIds: requested });
    assert.equal(batch.status, "ready"); assert.equal(batch.taskIds.length, 500); assert.deepEqual(batch.rows.map(({ taskId }) => taskId), fixture.tasks.map(({ taskId }) => taskId).sort()); assert.equal(batch.page.nextCursor, null);
    const first = projection.readTaskRuntimeBatch({ taskIds: requested.slice(0, 4), limit: 2 }), second = projection.readTaskRuntimeBatch({ taskIds: requested.slice(0, 4), limit: 2, cursor: first.page.nextCursor! });
    assert.deepEqual([...first.taskIds, ...second.taskIds], requested.slice(0, 4).sort()); assert.equal(second.page.nextCursor, null);
    assert.throws(() => projection.readTaskRuntimeBatch({ taskIds: [...requested, "task_over_limit"] }), /1\.\.500/u);
  });
});

test("task relation projection rows equal the snapshot-derived edges and survive a cold rebuild", async () => {
  const fixture = taskFixture();
  await withTempStoreAsync(async (rootDir) => {
    const projection = makeTaskProjection({ rootDir, eventStore: memoryEventStore(fixture.events) });
    const list = projection.list(), expected = list.rows.flatMap((row) => (row.snapshot.task?.relations ?? []).map((relation, recordIndex) => ({ relationId: relation.relation_id, sourceRef: relation.source, targetRef: relation.target, relationType: relation.type, direction: relation.direction, strength: relation.strength, origin: relation.origin, state: relation.state, rationale: relation.rationale, ownerRef: `task/${row.taskId}`, sourcePath: `${row.packagePath}/INDEX.md`, recordIndex })));
    const projected = projection.readTaskRelations();
    assert.equal(projected.status, "ready");
    assert.deepEqual([...projected.rows].sort((left, right) => left.relationId.localeCompare(right.relationId)), expected.sort((left, right) => left.relationId.localeCompare(right.relationId)));
    // Narrow pages over the event-backed edges concatenate to the same set, ordered by relation id.
    let page = projection.readRelationQuery({ limit: 1 }), rows = [...page.rows];
    while (page.page?.nextCursor) { page = projection.readRelationQuery({ limit: 1, cursor: page.page.nextCursor }); rows = [...rows, ...page.rows]; }
    assert.deepEqual(rows, projected.rows);
    // Entity/type filters narrow against the indexed columns.
    assert.deepEqual(projection.readRelationQuery({ entity: "task/task_query_03" }).rows.map((row) => row.relationId), projected.rows.filter((row) => row.sourceRef === "task/task_query_03" || row.targetRef === "task/task_query_03").map((row) => row.relationId));
    assert.deepEqual(projection.readRelationQuery({ relationType: "depends-on", state: "active" }).rows, projected.rows);
    assert.deepEqual(projection.readRelationQuery({ updatedAfter: "2026-08-26T00:00:00.000Z" }).rows, []);
  });
});

test("unparameterized list stays byte-identical across reopen after the schema bump", async () => {
  const fixture = taskFixture();
  await withTempStoreAsync(async (rootDir) => {
    const first = makeTaskProjection({ rootDir, eventStore: memoryEventStore(fixture.events) });
    first.list(); // cold catch-up; the first read may carry the one-shot projection_missing warning
    const bytes = JSON.stringify(first.list());
    first.close();
    const reopened = makeTaskProjection({ rootDir, eventStore: memoryEventStore(fixture.events) });
    assert.equal(JSON.stringify(reopened.list()), bytes);
    reopened.close();
    const rebuilt = makeTaskProjection({ rootDir, eventStore: memoryEventStore(fixture.events) });
    rebuilt.rebuild();
    assert.equal(JSON.stringify(rebuilt.list()), bytes);
    assert.equal(JSON.stringify(rebuilt.readTaskRelations().rows), JSON.stringify(first.readTaskRelations().rows));
  });
});

test("fact search pages concatenate to the full result, honor windows, and keep liveness exact", () => {
  const db = new DatabaseSync(":memory:");
  try {
    createRelationGraphProjectionTables(db);
    createFactProjectionTables(db);
    const insertFact = db.prepare("INSERT INTO fact(task_id, fact_id, ref, statement, evidence_source, observed_at, confidence, memory_class, op_id, workspace_revision, row_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)");
    const insertFts = db.prepare("INSERT INTO fact_fts(task_id, fact_id, statement, evidence_source) VALUES (?, ?, ?, ?)");
    db.exec("BEGIN");
    for (let index = 0; index < 40; index += 1) {
      const taskId = `task-${index % 4}`, factId = `F-${String(index).padStart(8, "0")}`, ref = `fact/${taskId}/${factId}`;
      const row: Omit<FactProjectionRow, "state"> = { schema: "fact-row/v1", ref, taskId, factId, statement: `fixture observation ${index}`,
        evidenceSource: "query fixture", observedAt: `2026-08-${String(10 + (index % 6)).padStart(2, "0")}T00:00:00.000Z`, confidence: index % 2 === 0 ? "high" : "low", memoryClass: "semantic", memoryTags: [],
        provenance: [{ runtime: "human", sessionId: "query", boundAt: "2026-08-10T00:00:00.000Z" }],
        actor: { principal: { personId: "query" }, executor: null }, source: "local", occurredAt: "2026-08-10T00:00:00.000Z", workspaceRevision: index + 1 };
      insertFact.run(taskId, factId, ref, row.statement, row.evidenceSource, row.observedAt, row.confidence, row.memoryClass, `op-${index}`, index + 1, JSON.stringify(row));
      insertFts.run(taskId, factId, row.statement, row.evidenceSource);
    }
    // fact/1 supersedes fact/0: the liveness computation must still see it through the narrowed fetch.
    db.prepare("INSERT INTO relation_edge VALUES (?, ?, ?, ?, ?, ?, ?, ?)").run("rel_sup_0", "fact/task-1/F-00000001", "fact/task-0/F-00000000", "supersedes-fact", "active", "fact/task-1/F-00000001", 41, JSON.stringify({ relationId: "rel_sup_0", sourceRef: "fact/task-1/F-00000001", targetRef: "fact/task-0/F-00000000", relationType: "supersedes-fact", direction: "directed", strength: "strong", origin: "declared", state: "active", rationale: "fixture", ownerRef: "fact/task-1/F-00000001", sourcePath: "event:op-41", recordIndex: 0 }));
    db.exec("COMMIT");
    const full = searchFactRows(db, {});
    assert.equal(full.length, 40);
    assert.equal(full.find((row) => row.ref === "fact/task-0/F-00000000")?.state, "superseded_fact");
    let page = searchFactRowsPage(db, { limit: 7 }), rows = [...page.rows!];
    while (page.page?.nextCursor) { page = searchFactRowsPage(db, { limit: 7, cursor: page.page!.nextCursor }); rows = [...rows, ...page.rows!]; }
    assert.deepEqual(rows, full, "paged fact search must concatenate to the full ordered result");
    assert.deepEqual(searchFactRowsPage(db, { observedAfter: "2026-08-13T00:00:00.000Z" }).rows, full.filter((row) => row.observedAt >= "2026-08-13T00:00:00.000Z"));
    assert.deepEqual(searchFactRowsPage(db, { refs: ["fact/task-0/F-00000000", "fact/task-1/F-00000001"] }).rows!.map((row) => row.ref), ["fact/task-1/F-00000001", "fact/task-0/F-00000000"].sort((left, right) => full.findIndex((row) => row.ref === left) - full.findIndex((row) => row.ref === right)));
    assert.deepEqual(readFactAnchorRows(db, ["fact/task-0/F-00000000"]).map((row) => row.factRef), ["fact/task-0/F-00000000"]);
    assert.deepEqual(readFactAnchorRows(db, []).length, 0);
    assert.equal(searchFactRows(db, { query: "observation 39" }).length, 1);
  } finally { db.close(); }
});
