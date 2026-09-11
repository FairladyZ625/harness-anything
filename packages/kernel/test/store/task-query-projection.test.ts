// harness-test-tier: integration
import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { makeTaskProjection } from "../../src/projection/rebuildable-task-projection.ts";
import {
  createFactProjectionTables,
  searchFactRows,
  searchFactRowsPage,
  readFactAnchorRows,
  type FactProjectionRow,
} from "../../src/projection/fact-event-projection.ts";
import { deriveRelationId, type EntityRelationRecord } from "../../src/domain/entity-relation.ts";
import { createRelationGraphProjectionTables } from "../../src/projection/relation-graph-projection.ts";
import {
  createTaskRelationProjectionTable,
  readTaskRelationNeighborhoodRows,
  readTaskRelationPage,
  type TaskRelationQuery,
} from "../../src/projection/task-query-projection.ts";
import { REPLAY_TASK_GRAPH } from "../../src/domain/task-graph.ts";
import type { CanonicalEventV1 } from "../../src/domain/doc-sync.contract.ts";
import type { TaskEventV1 } from "../../src/domain/task-lifecycle.contract.ts";
import type { TaskV2 } from "../../src/domain/task.ts";
import { serializeCanonicalEvent } from "../../src/domain/doc-sync.contract.ts";
import { sha256Text } from "../../src/integrity/stable-hash.ts";
import { withTempStoreAsync } from "./helpers.ts";
import { DatabaseSync } from "node:sqlite";

const actor = { principal: { personId: "person-query" }, executor: null } as const;

/** In-memory canonical event stream: the same port shape the git-backed store exposes, so the
 * projection's real cold catch-up (batching, prefetch, drain) runs against synthetic events. */
function memoryEventStore(events: readonly CanonicalEventV1[]) {
  return {
    readHead: () =>
      events.length === 0
        ? null
        : { revision: events.length, eventDigest: `sha256:${sha256Text(serializeCanonicalEvent(events.at(-1)!))}` },
    readBatch: (cursor: string | null, maxItems: number) => {
      const start = cursor === null ? 0 : Number(cursor),
        slice = events.slice(start, start + maxItems);
      return {
        sourceRevision: events.length,
        events: slice,
        cursor: start + slice.length >= events.length ? null : String(start + slice.length),
        done: start + slice.length >= events.length,
        accessedItems: slice.length,
        prefetchContent: () => new Map<string, Uint8Array | null>(),
      };
    },
    readContentBlob: () => null,
  };
}

interface Fixture {
  readonly events: readonly TaskEventV1[];
  readonly tasks: readonly TaskV2[];
}

/** 6 tasks across statuses and update times; task 2 and 4 own depends-on relations. */
function taskFixture(): Fixture {
  const events: TaskEventV1[] = [];
  let revision = 0;
  const statuses = ["planned", "active", "active", "blocked", "done", "planned"] as const;
  const tasks: TaskV2[] = [];
  for (let index = 0; index < statuses.length; index += 1) {
    const taskId = `task_query_${String(index).padStart(2, "0")}`,
      base: TaskV2 = {
        schema: "task/v2",
        taskId,
        title: `Query ${index}`,
        taskClass: "standard",
        status: "planned",
        graph: REPLAY_TASK_GRAPH,
        currentNode: "implementation",
        iteration: 0,
        pinned: false,
        createdBy: actor,
        completionGateIds: [],
        presetSnapshotDigest: null,
      };
    revision += 1;
    events.push(envelope(base, revision, `task_created`, { task: base }, `2026-08-1${index}T00:00:00.000Z`));
    if (statuses[index] !== "planned") {
      revision += 1;
      const transitioned = { ...base, status: statuses[index] };
      events.push(
        envelope(
          base,
          revision,
          "task_transitioned",
          {
            task: transitioned,
            mutation: { command: "transition" as const, reason: "fixture status", fields: ["status"] },
            documentClaims: [],
          },
          `2026-08-2${index}T00:00:00.000Z`,
        ),
      );
      tasks.push(transitioned);
    } else tasks.push(base);
  }
  for (const [source, target] of [
    ["task_query_02", "task_query_03"],
    ["task_query_04", "task_query_05"],
  ] as const) {
    const owner = tasks.find((task) => task.taskId === source)!,
      basis = {
        source: `task/${source}`,
        target: `task/${target}`,
        type: "depends-on" as const,
        direction: "directed" as const,
      },
      relation: EntityRelationRecord = {
        relation_id: deriveRelationId(basis),
        ...basis,
        strength: "strong",
        origin: "declared",
        rationale: "fixture dependency",
        state: "active",
      },
      related = { ...owner, relations: [...(owner.relations ?? []), relation] };
    revision += 1;
    events.push(
      envelope(
        owner,
        revision,
        "task_relation_added",
        {
          task: related,
          mutation: { command: "relate" as const, reason: relation.rationale, fields: [relation.relation_id] },
          documentClaims: [],
        },
        "2026-08-25T00:00:00.000Z",
      ),
    );
    tasks[tasks.indexOf(owner)] = related;
  }
  return { events, tasks };
}

function envelope(
  task: TaskV2,
  revision: number,
  type: TaskEventV1["type"],
  payload: Record<string, unknown>,
  occurredAt: string,
): TaskEventV1 {
  return {
    schema: "task-event/v1",
    eventId: `event-${revision}`,
    workspaceRevision: revision,
    opId: `op-${type}-${revision}`,
    taskId: task.taskId,
    type,
    actor,
    source: "local",
    occurredAt,
    payload: payload as never,
  } as TaskEventV1;
}

test("narrow task list pages concatenate to the unparameterized result and keep it byte-identical", async () => {
  const fixture = taskFixture();
  await withTempStoreAsync(async (rootDir) => {
    const projection = makeTaskProjection({ rootDir, eventStore: memoryEventStore(fixture.events) });
    projection.catchUp();
    const full = projection.list();
    assert.equal(full.rows.length, 6);
    assert.equal(full.page, undefined);
    const index = projection.readTaskIndex();
    assert.equal(index.schema, "task-index-projection/v1");
    assert.deepEqual(
      index.rows.map(({ taskId, title, status, parentTaskId, pinned }) => ({
        taskId,
        title,
        status,
        parentTaskId,
        pinned,
      })),
      full.rows.map(({ taskId, snapshot }) => ({
        taskId,
        title: snapshot.task!.title,
        status: snapshot.task!.status,
        parentTaskId: snapshot.task!.metadata?.parentTaskId ?? null,
        pinned: snapshot.task!.pinned,
      })),
    );
    // First page of 2, then follow cursors to exhaustion.
    let page = projection.list({ limit: 2 }),
      rows = [...page.rows];
    while (page.page?.nextCursor) {
      page = projection.list({ limit: 2, cursor: page.page.nextCursor });
      rows = [...rows, ...page.rows];
    }
    assert.equal(page.page?.nextCursor, null);
    assert.deepEqual(
      rows.map(({ taskId, snapshot, updatedAt }) => ({ taskId, status: snapshot.task?.status, updatedAt })),
      full.rows.map(({ taskId, snapshot, updatedAt }) => ({ taskId, status: snapshot.task?.status, updatedAt })),
    );
    assert.deepEqual(
      JSON.stringify(rows),
      JSON.stringify(full.rows),
      "paged rows must serialize identically to the unparameterized rows",
    );
    // Status filter equals the post-filter over the full read.
    for (const status of ["planned", "active", "blocked", "done"] as const) {
      assert.deepEqual(
        projection.list({ status }).rows.map((row) => row.taskId),
        full.rows.filter((row) => row.snapshot.task?.status === status).map((row) => row.taskId),
      );
    }
    // Time windows filter on the update timestamp with inclusive bounds.
    assert.deepEqual(
      projection.list({ updatedAfter: "2026-08-20T00:00:00.000Z" }).rows.map((row) => row.taskId),
      full.rows.filter((row) => row.updatedAt >= "2026-08-20T00:00:00.000Z").map((row) => row.taskId),
    );
    assert.deepEqual(
      projection
        .list({ updatedAfter: "2026-08-14T00:00:00.000Z", updatedBefore: "2026-08-20T00:00:00.000Z" })
        .rows.map((row) => row.taskId),
      full.rows
        .filter((row) => row.updatedAt >= "2026-08-14T00:00:00.000Z" && row.updatedAt <= "2026-08-20T00:00:00.000Z")
        .map((row) => row.taskId),
    );
    // Revision deltas use a strict boundary over the monotonic projected revision.
    assert.deepEqual(
      projection.list({ changedAfterRevision: 7 }).rows.map((row) => row.taskId),
      full.rows.filter((row) => row.workspaceRevision > 7).map((row) => row.taskId),
    );
    assert.deepEqual(projection.list({ changedAfterRevision: full.watermark }).rows, []);
    assert.deepEqual(
      projection.list({ status: "active", limit: 1 }).rows.map((row) => row.taskId),
      ["task_query_01"],
    );
  });
});

test("catch-up reports every bounded round and keeps an omitted progress callback as a no-op", async () => {
  const events = taskFixture().events.slice(0, 3);
  await withTempStoreAsync(async (rootDir) => {
    const progress: Array<{ readonly applied: number; readonly total: number; readonly watermark: number }> = [],
      projection = makeTaskProjection({
        rootDir,
        eventStore: memoryEventStore(events),
        catchUpLimit: 1,
        onProgress: (round) => progress.push({ ...round, total: round.total ?? -1 }),
      });
    projection.catchUp();
    assert.deepEqual(progress, [
      { applied: 1, total: 3, watermark: 1 },
      { applied: 2, total: 3, watermark: 2 },
      { applied: 3, total: 3, watermark: 3 },
    ]);
    projection.close();

    const quiet = makeTaskProjection({
      rootDir,
      projectionPath: path.join(rootDir, ".harness/cache/task-quiet.sqlite"),
      eventStore: memoryEventStore(events),
      catchUpLimit: 1,
    });
    assert.equal(quiet.catchUp().watermark, 3);
    quiet.close();
  });
});

test("catch-up does not report rounds whose projection watermark stays fixed", async () => {
  const event = taskFixture().events[0]!;
  await withTempStoreAsync(async (rootDir) => {
    let reads = 0;
    const progress: number[] = [],
      projection = makeTaskProjection({
        rootDir,
        eventStore: {
          readHead: () => ({
            revision: 1,
            eventDigest: `sha256:${sha256Text(serializeCanonicalEvent(event))}`,
          }),
          readBatch: () => {
            reads += 1;
            if (reads === 4) throw new Error("stop stalled catch-up fixture");
            return {
              sourceRevision: 1,
              events: [],
              cursor: String(reads),
              done: false,
              accessedItems: 1,
              prefetchContent: () => new Map<string, Uint8Array | null>(),
            };
          },
          readContentBlob: () => null,
        },
        onProgress: ({ watermark }) => progress.push(watermark),
      });
    assert.throws(() => projection.catchUp(), /stop stalled catch-up fixture/u);
    assert.equal(reads, 4);
    assert.deepEqual(progress, []);
    projection.close();
  });
});

test("task runtime batch reads up to 500 ids without a variable SQLite IN list", async () => {
  const fixture = taskFixture();
  await withTempStoreAsync(async (rootDir) => {
    const projection = makeTaskProjection({ rootDir, eventStore: memoryEventStore(fixture.events) }),
      requested = [
        ...fixture.tasks.map(({ taskId }) => taskId),
        ...Array.from({ length: 494 }, (_, index) => `task_missing_${String(index).padStart(3, "0")}`),
      ];
    projection.catchUp();
    const batch = projection.readTaskRuntimeBatch({ taskIds: requested });
    assert.equal(batch.status, "ready");
    assert.equal(batch.taskIds.length, 500);
    assert.deepEqual(
      batch.rows.map(({ taskId }) => taskId),
      fixture.tasks.map(({ taskId }) => taskId).sort(),
    );
    assert.equal(batch.page.nextCursor, null);
    const first = projection.readTaskRuntimeBatch({ taskIds: requested.slice(0, 4), limit: 2 }),
      second = projection.readTaskRuntimeBatch({
        taskIds: requested.slice(0, 4),
        limit: 2,
        cursor: first.page.nextCursor!,
      });
    assert.deepEqual([...first.taskIds, ...second.taskIds], requested.slice(0, 4).sort());
    assert.equal(second.page.nextCursor, null);
    assert.throws(() => projection.readTaskRuntimeBatch({ taskIds: [...requested, "task_over_limit"] }), /1\.\.500/u);
  });
});

test("historical task relation events replay into the Relation projection and survive a cold rebuild", async () => {
  const fixture = taskFixture();
  await withTempStoreAsync(async (rootDir) => {
    const projection = makeTaskProjection({ rootDir, eventStore: memoryEventStore(fixture.events) });
    projection.catchUp();
    // The stored snapshot no longer hosts legacy task.relations (normalized via
    // currentTaskForWrite), so the expectation derives from the event payloads —
    // the same replay input the Relation projection consumes.
    const expected = fixture.events
      .filter((event) => event.type === "task_relation_added")
      .flatMap((event) => {
        const task = event.payload.task as (typeof fixture.tasks)[number] & {
          readonly relations?: readonly EntityRelationRecord[];
        };
        return (task.relations ?? []).map((relation, recordIndex) => {
          const targetTaskId = relation.target.slice("task/".length),
            targetVersion = Math.max(
              ...fixture.events
                .filter((candidate) => candidate.taskId === targetTaskId)
                .map(({ workspaceRevision }) => workspaceRevision),
            );
          return {
            relationId: relation.relation_id,
            sourceRef: relation.source,
            targetRef: relation.target,
            relationType: relation.type,
            direction: relation.direction,
            strength: relation.strength,
            origin: relation.origin,
            state: relation.state,
            targetObservedVersion: targetVersion,
            currentTargetVersion: targetVersion,
            freshness: "current" as const,
            rationale: relation.rationale,
            ownerRef: `task/${task.taskId}`,
            sourcePath: `event:${event.opId}`,
            recordIndex,
          };
        });
      });
    const projected = projection.readTaskRelations();
    assert.equal(projected.status, "ready");
    assert.deepEqual(
      [...projected.rows].sort((left, right) => left.relationId.localeCompare(right.relationId)),
      expected.sort((left, right) => left.relationId.localeCompare(right.relationId)),
    );
    // Narrow pages over the event-backed edges concatenate to the same set, ordered by relation id.
    let page = projection.readRelationQuery({ limit: 1 }),
      rows = [...page.rows];
    while (page.page?.nextCursor) {
      page = projection.readRelationQuery({ limit: 1, cursor: page.page.nextCursor });
      rows = [...rows, ...page.rows];
    }
    assert.deepEqual(rows, projected.rows);
    // Entity/type filters narrow against the indexed columns.
    assert.deepEqual(
      projection.readRelationQuery({ entity: "task/task_query_03" }).rows.map((row) => row.relationId),
      projected.rows
        .filter((row) => row.sourceRef === "task/task_query_03" || row.targetRef === "task/task_query_03")
        .map((row) => row.relationId),
    );
    assert.deepEqual(
      projection.readRelationQuery({ relationType: "depends-on", state: "active" }).rows,
      projected.rows,
    );
    const neighborhood = projection.readTaskRelationNeighborhood({
      seed: "task/task_query_03",
      direction: "incoming",
      relationTypes: ["depends-on"],
      maxDepth: 1,
      maxNodes: 2,
      state: "active",
    });
    assert.deepEqual(
      neighborhood.rows.map(({ sourceRef, targetRef }) => [sourceRef, targetRef]),
      [["task/task_query_02", "task/task_query_03"]],
    );
    assert.deepEqual(
      { status: neighborhood.status, watermark: neighborhood.watermark, sourceRevision: neighborhood.sourceRevision },
      { status: projected.status, watermark: projected.watermark, sourceRevision: projected.sourceRevision },
    );
    assert.throws(
      () =>
        projection.readTaskRelationNeighborhood({
          seed: "task/task_query_03",
          direction: "incoming",
          relationTypes: ["depends-on"],
          maxDepth: 1,
          maxNodes: 1,
          state: "active",
        }),
      /relation neighborhood node budget 1 exceeded/u,
    );
    assert.throws(
      () =>
        projection.readTaskRelationNeighborhood({
          seed: "task/task_query_03",
          direction: "incoming",
          relationTypes: [],
          maxDepth: 1,
          maxNodes: 2,
        }),
      /relation neighborhood types requires at least one ref/u,
    );
    assert.deepEqual(projection.readRelationQuery({ updatedAfter: "2026-08-26T00:00:00.000Z" }).rows, []);
  });
});

test("relation neighborhood fails closed at the depth boundary", () => {
  const db = new DatabaseSync(":memory:");
  try {
    createRelationGraphProjectionTables(db);
    const insert = db.prepare(
      "INSERT INTO relation_edge(relation_id, source_ref, target_ref, relation_type, state, owner_ref, row_json, workspace_revision) VALUES (?, ?, ?, 'depends-on', 'active', ?, ?, 1)",
    );
    for (const [id, source, target] of [
      ["rel-a", "task/a", "task/b"],
      ["rel-b", "task/b", "task/c"],
    ])
      insert.run(
        id,
        source,
        target,
        source,
        JSON.stringify({
          direction: "directed",
          strength: "strong",
          origin: "declared",
          rationale: "fixture",
          sourcePath: "fixture",
          recordIndex: 0,
        }),
      );
    assert.throws(
      () =>
        readTaskRelationNeighborhoodRows(db, {
          seed: "task/a",
          direction: "outgoing",
          relationTypes: ["depends-on"],
          maxDepth: 1,
          maxNodes: 10,
          state: "active",
        }),
      /relation neighborhood depth limit 1 exceeded/u,
    );
  } finally {
    db.close();
  }
});

test("unparameterized list stays byte-identical across reopen after the schema bump", async () => {
  const fixture = taskFixture();
  await withTempStoreAsync(async (rootDir) => {
    const first = makeTaskProjection({ rootDir, eventStore: memoryEventStore(fixture.events) });
    first.catchUp();
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
    const insertFact = db.prepare(
      "INSERT INTO fact(task_id, fact_id, ref, statement, evidence_source, observed_at, confidence, memory_class, op_id, workspace_revision, row_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    );
    const insertFts = db.prepare("INSERT INTO fact_fts(fact_id, statement, evidence_source) VALUES (?, ?, ?)");
    db.exec("BEGIN");
    for (let index = 0; index < 40; index += 1) {
      const taskId = `task-${index % 4}`,
        factId = `F-${String(index).padStart(8, "0")}`,
        ref = `fact/${factId}`;
      const row: Omit<FactProjectionRow, "state"> = {
        schema: "fact-row/v1",
        ref,
        taskId,
        factId,
        statement: `fixture observation ${index}`,
        evidenceSource: "query fixture",
        observedAt: `2026-08-${String(10 + (index % 6)).padStart(2, "0")}T00:00:00.000Z`,
        confidence: index % 2 === 0 ? "high" : "low",
        memoryClass: "semantic",
        memoryTags: [],
        provenance: [{ runtime: "human", sessionId: "query", boundAt: "2026-08-10T00:00:00.000Z" }],
        actor: { principal: { personId: "query" }, executor: null },
        source: "local",
        occurredAt: "2026-08-10T00:00:00.000Z",
        workspaceRevision: index + 1,
      };
      insertFact.run(
        taskId,
        factId,
        ref,
        row.statement,
        row.evidenceSource,
        row.observedAt,
        row.confidence,
        row.memoryClass,
        `op-${index}`,
        index + 1,
        JSON.stringify(row),
      );
      insertFts.run(factId, row.statement, row.evidenceSource);
    }
    // fact/1 supersedes fact/0: the liveness computation must still see it through the narrowed fetch.
    db.prepare("INSERT INTO relation_edge VALUES (?, ?, ?, ?, ?, NULL, ?, ?, ?)").run(
      "rel_sup_0",
      "fact/F-00000001",
      "fact/F-00000000",
      "supersedes-fact",
      "active",
      "fact/F-00000001",
      41,
      JSON.stringify({
        relationId: "rel_sup_0",
        sourceRef: "fact/F-00000001",
        targetRef: "fact/F-00000000",
        relationType: "supersedes-fact",
        direction: "directed",
        strength: "strong",
        origin: "declared",
        state: "active",
        rationale: "fixture",
        ownerRef: "fact/F-00000001",
        sourcePath: "event:op-41",
        recordIndex: 0,
      }),
    );
    db.exec("COMMIT");
    const full = searchFactRows(db, {});
    assert.equal(full.length, 40);
    assert.equal(full.find((row) => row.ref === "fact/F-00000000")?.state, "superseded_fact");
    let page = searchFactRowsPage(db, { limit: 7 }),
      rows = [...page.rows!];
    while (page.page?.nextCursor) {
      page = searchFactRowsPage(db, { limit: 7, cursor: page.page!.nextCursor });
      rows = [...rows, ...page.rows!];
    }
    assert.deepEqual(rows, full, "paged fact search must concatenate to the full ordered result");
    assert.deepEqual(
      searchFactRowsPage(db, { observedAfter: "2026-08-13T00:00:00.000Z" }).rows,
      full.filter((row) => row.observedAt >= "2026-08-13T00:00:00.000Z"),
    );
    assert.deepEqual(
      searchFactRowsPage(db, { refs: ["fact/F-00000000", "fact/F-00000001"] }).rows!.map((row) => row.ref),
      ["fact/F-00000001", "fact/F-00000000"].sort(
        (left, right) => full.findIndex((row) => row.ref === left) - full.findIndex((row) => row.ref === right),
      ),
    );
    assert.deepEqual(
      readFactAnchorRows(db, ["fact/F-00000000"]).map((row) => row.factRef),
      ["fact/F-00000000"],
    );
    assert.deepEqual(readFactAnchorRows(db, []).length, 0);
    assert.equal(searchFactRows(db, { query: "observation 39" }).length, 1);
  } finally {
    db.close();
  }
});

test("fact search liveness reads only supersedes edges, however many facts and edges exist", () => {
  const db = new DatabaseSync(":memory:");
  try {
    createRelationGraphProjectionTables(db);
    createFactProjectionTables(db);
    const insertFact = db.prepare(
        "INSERT INTO fact(task_id, fact_id, ref, statement, evidence_source, observed_at, confidence, memory_class, op_id, workspace_revision, row_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      ),
      insertFts = db.prepare("INSERT INTO fact_fts(fact_id, statement, evidence_source) VALUES (?, ?, ?)");
    db.exec("BEGIN");
    for (let index = 0; index < 2000; index += 1) {
      const factId = `F-${String(index).padStart(8, "0")}`,
        ref = `fact/${factId}`,
        row = {
          schema: "fact-row/v1",
          ref,
          taskId: "task-scale",
          factId,
          statement: `scale observation ${index}`,
          evidenceSource: "scale",
          observedAt: "2026-08-18T00:00:00.000Z",
          confidence: "high",
          memoryClass: "semantic",
          memoryTags: [],
          provenance: [],
          actor: { principal: { personId: "scale" }, executor: null },
          source: "local",
          occurredAt: "2026-08-18T00:00:00.000Z",
          workspaceRevision: index + 1,
        };
      insertFact.run(
        "task-scale",
        factId,
        ref,
        row.statement,
        row.evidenceSource,
        row.observedAt,
        row.confidence,
        row.memoryClass,
        `op-${index}`,
        index + 1,
        JSON.stringify(row),
      );
      insertFts.run(factId, row.statement, row.evidenceSource);
    }
    db.prepare("INSERT INTO relation_edge VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)").run(
      "rel-scale",
      "fact/F-00000001",
      "fact/F-00000000",
      "supersedes-fact",
      "active",
      null,
      "fact/F-00000001",
      2001,
      JSON.stringify({
        relationId: "rel-scale",
        sourceRef: "fact/F-00000001",
        targetRef: "fact/F-00000000",
        relationType: "supersedes-fact",
        state: "active",
      }),
    );
    // Unrelated active edges: a liveness read that scans the edge table pays for every one of them.
    const insertEdge = db.prepare("INSERT INTO relation_edge VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)");
    for (let index = 0; index < 3000; index += 1)
      insertEdge.run(
        `rel-unrelated-${index}`,
        "task/task-scale",
        `fact/F-${String(index % 2000).padStart(8, "0")}`,
        "produces",
        "active",
        null,
        `fact/F-${String(index % 2000).padStart(8, "0")}`,
        3000 + index,
        JSON.stringify({ relationId: `rel-unrelated-${index}`, relationType: "produces", state: "active" }),
      );
    db.exec("COMMIT");
    const original = db.prepare;
    let rowsRead = 0;
    db.prepare = ((...args: Parameters<typeof original>) => {
      const statement = original.apply(db, args);
      const all = statement.all.bind(statement),
        get = statement.get.bind(statement);
      statement.all = (...values: unknown[]) => {
        const result = all(...values);
        rowsRead += Array.isArray(result) ? result.length : 0;
        return result;
      };
      statement.get = (...values: unknown[]) => {
        const result = get(...values);
        rowsRead += result === undefined ? 0 : 1;
        return result;
      };
      return statement;
    }) as typeof db.prepare;
    // Unpaged: every fact is decoded, which is past the old 900-target cut-off.
    const rows = searchFactRows(db, {});
    assert.equal(rows.length, 2000);
    assert.equal(rows.find((row) => row.factId === "F-00000000")?.invalidated, true);
    assert.equal(rows.find((row) => row.factId === "F-00000001")?.invalidated, false);
    console.log(JSON.stringify({ factCount: 2000, unrelatedEdges: 3000, sqlRowsRead: rowsRead }));
    // 2,000 fact rows plus the one supersedes edge; reading the 3,000 unrelated edges would exceed this.
    assert.ok(rowsRead <= 2000 + 50, `liveness read ${rowsRead} rows`);
  } finally {
    db.close();
  }
});

test("a relation read with a fixed endpoint searches only that endpoint's edges, however many other edges exist", () => {
  // Both tables hold a 60-hop depends-on chain plus unrelated depends-on and relates edges. A read that
  // lets the type or state index drive visits every edge of that type or state on each call; the cycle
  // check on relation relate makes one such call per hop, and entity import makes one per write.
  const queries: readonly TaskRelationQuery[] = [
    { source: "task/chain-30", relationType: "depends-on", state: "active" },
    { target: "task/chain-30", state: "active" },
    { entity: "task/chain-30", state: "active" },
  ];
  const shapes = [200, 5000].map((unrelated) => {
    const db = new DatabaseSync(":memory:");
    try {
      createRelationGraphProjectionTables(db);
      createTaskRelationProjectionTable(db);
      db.exec(
        "CREATE TABLE IF NOT EXISTS event_index (op_id TEXT PRIMARY KEY, workspace_revision INTEGER NOT NULL UNIQUE, task_id TEXT, event_json TEXT NOT NULL)",
      );
      const edge = db.prepare("INSERT INTO relation_edge VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)"),
        mirror = db.prepare("INSERT INTO task_relation VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)");
      let revision = 0;
      const add = (source: string, target: string, type: string) => {
        revision += 1;
        const id = `rel-${String(revision).padStart(8, "0")}`;
        edge.run(id, source, target, type, "active", null, source, revision, JSON.stringify({ relationId: id }));
        mirror.run(
          id,
          source.slice(5),
          source,
          target,
          type,
          "directed",
          "hard",
          "authored",
          "active",
          "",
          source,
          "",
          0,
          revision,
          "",
        );
      };
      db.exec("BEGIN");
      for (let hop = 0; hop < 60; hop += 1) add(`task/chain-${hop}`, `task/chain-${hop + 1}`, "depends-on");
      for (let index = 0; index < unrelated; index += 1) {
        add(`task/other-${index}`, `task/other-${index + 1}`, "depends-on");
        add(`task/other-${index}`, "task/hub", "relates");
      }
      db.exec("COMMIT");
      const original = db.prepare,
        statements: string[] = [];
      db.prepare = ((sql: string) => {
        statements.push(sql);
        return original.call(db, sql);
      }) as typeof db.prepare;
      return queries.map((query) => {
        statements.length = 0;
        const rows = readTaskRelationPage(db, query).rows.map((row) => `${row.sourceRef}>${row.targetRef}`),
          sql = statements.find((statement) => statement.includes("UNION ALL"))!,
          values = [query.entity, query.entity, query.source, query.target, query.relationType, query.state].filter(
            (value) => value !== undefined,
          ),
          plan = (original.call(db, `EXPLAIN QUERY PLAN ${sql}`).all(...values) as { detail: string }[])
            .map(({ detail }) => detail)
            .filter(
              (detail) => /\b(task_relation|relation_edge)\b/u.test(detail) && !/\(relation_id=\?\)/u.test(detail),
            );
        return { rows, plan };
      });
    } finally {
      db.close();
    }
  });
  for (const [index, query] of queries.entries()) {
    const [small, large] = [shapes[0]![index]!, shapes[1]![index]!];
    assert.deepEqual(large.rows, small.rows, JSON.stringify(query));
    assert.ok(small.plan.length >= 2, `${JSON.stringify(query)} plan: ${small.plan.join("; ")}`);
    for (const detail of [...small.plan, ...large.plan])
      assert.match(
        detail,
        /^SEARCH \w+ USING (?:COVERING )?INDEX \w+ \((?:source_ref|target_ref)=\?\)$/u,
        JSON.stringify(query),
      );
  }
  assert.deepEqual(
    shapes[1]!.map(({ rows }) => rows),
    [
      ["task/chain-30>task/chain-31"],
      ["task/chain-29>task/chain-30"],
      ["task/chain-29>task/chain-30", "task/chain-30>task/chain-31"],
    ],
  );
});
