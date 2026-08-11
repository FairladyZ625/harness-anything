// harness-test-tier: integration
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { Effect } from "effect";
import { REPLAY_TASK_GRAPH } from "../../src/domain/task-graph.ts";
import type { TaskCreatedEvent } from "../../src/domain/task-lifecycle.contract.ts";
import { makeJournaledWriteCoordinator } from "../../src/store/write-journal-coordinator.ts";
import { makeTaskEventStore } from "../../src/store/task-event-store.ts";
import { withTempStoreAsync } from "./helpers.ts";

const event: TaskCreatedEvent = {
  schema: "task-event/v1",
  eventId: "event-1",
  workspaceRevision: 1,
  opId: "op-1",
  taskId: "task-1",
  type: "task_created",
  actor: { principal: { personId: "person-1" }, executor: { kind: "agent", id: "codex" } },
  occurredAt: "2026-08-11T00:00:00.000Z",
  payload: {
    task: {
      schema: "task/v1",
      taskId: "task-1",
      title: "Replay task",
      status: "planned",
      graph: REPLAY_TASK_GRAPH,
      currentNode: "implementation",
      iteration: 0,
      createdBy: { principal: { personId: "person-1" }, executor: { kind: "agent", id: "codex" } },
      completionGateIds: []
    }
  }
};

test("task event store starts empty and appends one canonical event per revision", async () => {
  await withTempStoreAsync(async (rootDir) => {
    const store = makeTaskEventStore({
      rootDir,
      coordinator: makeJournaledWriteCoordinator({ rootDir })
    });

    assert.deepEqual(store.read(), { schema: "task-event-stream/v1", revision: 0, events: [] });
    const receipt = Effect.runSync(store.append(event));

    assert.equal(receipt.status, "applied");
    assert.equal(Effect.runSync(store.append(event)).revision, 1);
    assert.throws(() => Effect.runSync(store.append({ ...event, payload: { task: { ...event.payload.task, title: "different" } } })), /different event/u);
    assert.throws(() => Effect.runSync(store.append({ ...event, opId: "op-2", eventId: "event-2" })), /revision/u);
    assert.deepEqual(store.read().events, [event]);
    assert.equal(
      readFileSync(path.join(rootDir, "harness/task-events.ndjson"), "utf8"),
      '{"actor":{"executor":{"id":"codex","kind":"agent"},"principal":{"personId":"person-1"}},"eventId":"event-1","occurredAt":"2026-08-11T00:00:00.000Z","opId":"op-1","payload":{"task":{"completionGateIds":[],"createdBy":{"executor":{"id":"codex","kind":"agent"},"principal":{"personId":"person-1"}},"currentNode":"implementation","graph":{"edges":[{"actorRole":"executor","from":"implementation","id":"implementation-submitted","kind":"forward","on":"submitted","to":"anti_entropy"},{"actorRole":"anti_entropy","from":"anti_entropy","id":"anti-entropy-approved","kind":"forward","on":"approved","to":"review"},{"actorRole":"anti_entropy","from":"anti_entropy","id":"anti-entropy-changes-requested","kind":"return","on":"changes_requested","to":"implementation"}],"maxIterations":1,"nodes":[{"id":"implementation","kind":"work"},{"id":"anti_entropy","kind":"adversarial"},{"id":"review","kind":"review"}],"template":"replay/v1"},"iteration":0,"schema":"task/v1","status":"planned","taskId":"task-1","title":"Replay task"}},"schema":"task-event/v1","taskId":"task-1","type":"task_created","workspaceRevision":1}\n'
    );
  });
});

test("task event store rejects legacy shapes with archive/main guidance", async () => {
  await withTempStoreAsync(async (rootDir) => {
    const store = makeTaskEventStore({ rootDir, coordinator: makeJournaledWriteCoordinator({ rootDir }) });
    const fixture = readFileSync(path.resolve("tools/gates/test/fixtures/task-event-legacy-shape.json"), "utf8");
    mkdirSync(path.join(rootDir, "harness"), { recursive: true });
    writeFileSync(path.join(rootDir, "harness/task-events.ndjson"), fixture, "utf8");

    assert.throws(() => store.read(), /legacy task event shape.*archive\/main/iu);
  });
});
