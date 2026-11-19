// harness-test-tier: contract
import assert from "node:assert/strict";
import test from "node:test";
import { compileEntityPinEvent, compileEntityUpsert } from "@harness-anything/kernel";
import { makeTaskEventStore } from "../../src/store/task-event-store.ts";
import { makeTaskProjection } from "../../src/projection/rebuildable-task-projection.ts";
import { initRepo } from "./task-event-store.fixtures.ts";
import { withTempStore } from "./helpers.ts";

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
