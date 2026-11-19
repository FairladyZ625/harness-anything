// harness-test-tier: contract
import assert from "node:assert/strict";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import {
  applyTransition,
  compileEntityPinEvent,
  compileEntityUpsert,
  normalizeTaskLifecycleCommand,
  taskLifecycleWritePlan,
  type PersistedCanonicalEventV1,
} from "@harness-anything/kernel";
import { serializeCanonicalEventUnchecked } from "@harness-anything/kernel/internal/domain/doc-sync-canonical-events.ts";
import { sha256Text } from "@harness-anything/kernel/internal/integrity/stable-hash.ts";
import { lifecycleFixture } from "../../../kernel/test/store/task-lifecycle-fixture.ts";
import { makeTaskEventReader } from "../../src/store/task-event-store-factory.ts";
import {
  activateEmptyCanonicalGeneration,
  openSqliteEventStore,
  sqliteLedgerPath,
} from "../../src/store/sqlite-event-store.ts";
import { projectEventSummary } from "../../src/projection/event-summary-projection.ts";
import { createProjectionTables } from "../../src/projection/projection-tables.ts";
import { listPinnedEntityRows } from "../../src/projection/rebuildable-task-projection-entities.ts";
import { makeTaskEventStore, type CanonicalWriteBundle } from "../../src/store/task-event-store.ts";
import { makeTaskProjection } from "../../src/projection/rebuildable-task-projection.ts";
import { initRepo } from "./task-event-store.fixtures.ts";
import { withTempStore, withTempStoreAsync } from "./helpers.ts";

test("pin events isolate people and Todo creation provenance survives another member's update and replay", () => {
  withTempStore((rootDir) => {
    initRepo(rootDir);
    const eventStore = makeTaskEventStore({ repoId: "collaborators", rootDir }),
      projection = makeTaskProjection({ rootDir, eventStore }),
      todoId = "todo_1234567890abcdef12345678",
      entityRef = `todo/${todoId}`;
    let revision = 0;
    const envelope = (personId: string) => ({
      actor: { principal: { personId }, executor: null },
      source: (personId === "person_bob" ? { kind: "node", nodeId: "edge-b" } : "local") as
        | "local"
        | { kind: "node"; nodeId: string },
      opId: `collaborator-${++revision}`,
      eventId: `event-collaborator-${revision}`,
      workspaceRevision: revision,
      occurredAt: "2026-11-19T02:00:00.000Z",
    });
    const append = (bundle: ReturnType<typeof compileEntityPinEvent> | ReturnType<typeof compileEntityUpsert>) => {
      eventStore.append(bundle);
      projection.apply(bundle.event, bundle.plan);
    };
    const todo = { id: todoId, text: "Confirm the shared Work", completed: false, archived: false };
    append(compileEntityUpsert({ ...envelope("person_alice"), entityKind: "todo", entity: todo }));
    append(compileEntityPinEvent({ ...envelope("person_alice"), entityRef, pinned: true }));
    assert.deepEqual(projection.listPinnedEntities("person_bob"), []);
    append(compileEntityPinEvent({ ...envelope("person_bob"), entityRef, pinned: true }));
    assert.equal(projection.listPinnedEntities("person_bob")[0]?.pinnedBy, "person_bob");
    append(compileEntityPinEvent({ ...envelope("person_bob"), entityRef, pinned: false }));
    append(
      compileEntityUpsert({ ...envelope("person_bob"), entityKind: "todo", entity: { ...todo, completed: true } }),
    );

    const assertCut = () => {
      assert.deepEqual(
        projection.listPinnedEntities("person_alice").map((pin) => pin.entityRef),
        [entityRef],
      );
      assert.deepEqual(projection.listPinnedEntities("person_bob"), []);
      assert.equal(projection.getEntity("todo", todoId)?.createdByPersonId, "person_alice");
      assert.equal(projection.listEntities("todo")[0]?.originNodeId, "center");
    };
    assertCut();
    assert.equal(projection.rebuild().watermark, revision);
    assertCut();
    projection.close();
  });
});

test("cancellation retires each member's pin without retiring pins on ordinary transitions", () => {
  withTempStore((rootDir) => {
    initRepo(rootDir);
    const eventStore = makeTaskEventStore({ repoId: "cancelled-pins", rootDir }),
      projection = makeTaskProjection({ rootDir, eventStore }),
      taskId = "task-cancelled-pin",
      entityRef = `task/${taskId}`,
      members = ["person_alice", "person_bob"];
    let revision = 0;
    const append = (bundle: CanonicalWriteBundle) => {
      eventStore.append(bundle);
      projection.apply(bundle.event, bundle.plan);
    };
    const envelope = (personId: string) => ({
      actor: { principal: { personId }, executor: null },
      source: "local" as const,
      opId: `pin-transition-${++revision}`,
      eventId: `pin-transition-event-${revision}`,
      workspaceRevision: revision,
      occurredAt: "2026-11-19T02:00:00.000Z",
    });
    const created = lifecycleFixture({ taskId }).events[0]!;
    assert.equal(created.type, "task_created");
    const initial = { ...created, ...envelope("person_alice") };
    append({ event: initial, plan: taskLifecycleWritePlan(initial), blobs: [] });
    const pin = (personId: string) => append(compileEntityPinEvent({ ...envelope(personId), entityRef, pinned: true }));
    const transition = (status: "blocked" | "cancelled") => {
      const identity = envelope("person_alice"),
        snapshot = projection.read(taskId).snapshot,
        command = {
          ...normalizeTaskLifecycleCommand(
            {
              workspaceId: "cancelled-pins",
              actor: identity.actor,
              source: identity.source,
              expectedRevision: snapshot.revision,
            },
            { type: "TransitionTask", taskId, status, reason: "Personal pin lifecycle fixture" },
          ),
          workspaceRevision: identity.workspaceRevision,
          eventId: identity.eventId,
          occurredAt: identity.occurredAt,
        },
        { event } = applyTransition(snapshot, command, {});
      append({ event, plan: taskLifecycleWritePlan(event), blobs: [] });
      return event;
    };
    try {
      for (const member of members) pin(member);
      transition("blocked");
      for (const member of members) assert.equal(projection.listPinnedEntities(member).length, 1);

      const cancelled = transition("cancelled");
      for (const member of members)
        assert.deepEqual(
          projection.listPinnedEntities(member),
          [],
          "cancellation frees the member's one occupied slot",
        );
      assert.equal(projection.rebuild().watermark, revision);
      for (const member of members) assert.deepEqual(projection.listPinnedEntities(member), []);

      // Replay supports a later restored snapshot even though the current command API makes
      // cancellations terminal. The cancellation must still fence only earlier Pin revisions.
      const restored = {
        ...cancelled,
        ...envelope("person_alice"),
        type: "task_transitioned",
        payload: {
          task: { ...cancelled.payload.task, status: "planned" },
          mutation: { command: "transition", reason: "Historical restored snapshot", fields: ["status"] },
          documentClaims: [],
        },
      } as const;
      append({ event: restored, plan: taskLifecycleWritePlan(restored), blobs: [] });
      pin(members[1]!);
      assert.deepEqual(projection.listPinnedEntities(members[0]!), []);
      assert.equal(projection.listPinnedEntities(members[1]!)[0]?.entityRef, entityRef);
      assert.equal(projection.rebuild().watermark, revision);
      assert.equal(projection.listPinnedEntities(members[1]!)[0]?.entityRef, entityRef);
    } finally {
      projection.close();
    }
  });
});

test("cold replay reads principal-less persisted Pin and Unpin without changing personal or legacy pins", async () => {
  await withTempStoreAsync(async (rootDir) => {
    initRepo(rootDir);
    const repoId = "historical-pins",
      entityRef = "task/task-historical-pin",
      actor = { principal: { personId: "person_alice" }, executor: null },
      occurredAt = "2026-11-19T02:00:00.000Z";
    activateEmptyCanonicalGeneration({ rootInput: rootDir, repoId });
    const empty = openSqliteEventStore({ rootInput: rootDir, repoId, generation: 3 });
    empty.close();
    const events = [true, true, false].map((pinned, index) => {
      const { event } = compileEntityPinEvent({
        actor,
        source: "local",
        entityRef,
        pinned,
        occurredAt,
        workspaceRevision: index + 1,
        opId: `legacy-pin-${index}`,
        eventId: `legacy-pin-event-${index}`,
      });
      return index === 0 ? event : { ...event, actor: { principal: {}, executor: null } };
    });
    const db = new DatabaseSync(sqliteLedgerPath(rootDir, 3));
    try {
      const insert = db.prepare(
        "INSERT INTO event(revision,op_id,event_json,digest,occurred_at,recorded_at) VALUES (?,?,?,?,?,?)",
      );
      for (const event of events) {
        const body = serializeCanonicalEventUnchecked(event as PersistedCanonicalEventV1);
        insert.run(event.workspaceRevision, event.opId, body, `sha256:${sha256Text(body)}`, occurredAt, occurredAt);
      }
      db.prepare("UPDATE ledger_meta SET revision=? WHERE singleton=1").run(events.length);
    } finally {
      db.close();
    }
    const reader = makeTaskEventReader({ rootDir, repoId, generation: 3 }),
      projection = makeTaskProjection({ rootDir, eventStore: reader });
    try {
      assert.deepEqual(reader.read().events, events);
      assert.equal(projection.rebuild().watermark, 3);
      assert.equal(projection.listPinnedEntities("person_alice")[0]?.entityRef, entityRef);
      assert.deepEqual(projection.listPinnedEntities("person_bob"), []);
      assert.equal(projection.listPinnedEntities()[0]?.pinnedBy, "person_alice");
    } finally {
      projection.close();
      await reader.drain();
    }
  });
});

test("personal Pin read grows with the toggle history plus one Work event suffix", (t) => {
  const measure = (size: number) => {
    const db = new DatabaseSync(":memory:");
    try {
      createProjectionTables(db);
      const insert = db.prepare(
          "INSERT INTO event_index(op_id,workspace_revision,task_id,event_json) VALUES (?,?,?,?)",
        ),
        workId = "task-scale-work",
        entityRef = `task/${workId}`,
        occurredAt = "2026-11-19T02:00:00.000Z";
      db.exec("BEGIN");
      for (let revision = 1; revision <= size * 2; revision += 1) {
        const event = {
          schema: revision <= size ? "entity-pin-event/v1" : "task-event/v1",
          eventId: `pin-scale-event-${revision}`,
          opId: `pin-scale-${revision}`,
          workspaceRevision: revision,
          actor: { principal: { personId: "person_alice" }, executor: null },
          source: "local",
          occurredAt,
          type: revision > size ? "task_amended" : revision % 2 === 0 ? "entity_pinned" : "entity_unpinned",
          payload: revision > size ? { taskId: workId } : { entityRef },
        };
        insert.run(event.opId, revision, revision > size ? workId : null, JSON.stringify(event));
        projectEventSummary(db, event as PersistedCanonicalEventV1);
      }
      db.exec("COMMIT");
      const read = () => listPinnedEntityRows(db, "person_alice");
      assert.deepEqual(
        read().map((pin) => pin.entityRef),
        [entityRef],
      );
      return Array.from({ length: 9 }, () => {
        const start = performance.now();
        read();
        return performance.now() - start;
      }).sort((left, right) => left - right)[4]!;
    } finally {
      db.close();
    }
  };
  const small = measure(400),
    large = measure(1600);
  t.diagnostic(`400 toggles + 400 activity events: ${small.toFixed(3)} ms, 1600 + 1600: ${large.toFixed(3)} ms`);
  assert.ok(
    large < small * 10,
    `Quadrupling both histories increased median latency by ${(large / small).toFixed(2)}x`,
  );
});
