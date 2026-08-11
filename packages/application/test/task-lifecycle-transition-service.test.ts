// harness-test-tier: integration
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { makeJournaledWriteCoordinator } from "../../kernel/src/index.ts";
import { makeTaskEventStore, makeTaskLeaseStore, makeTaskProjection } from "../../kernel/test/store/task-lifecycle-runtime.ts";
import { makeTaskLifecycleService, TaskLifecycleOperationConflict } from "../src/task-lifecycle-service.ts";
import { lifecycleHarness, replayGraph } from "./task-lifecycle-test-harness.ts";

const actor = { principal: { personId: "person-owner" }, executor: { kind: "agent" as const, id: "codex" } };

test("transition service freezes targets and makes create/start idempotent by opId payload", async () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "ha-lifecycle-service-"));
  try {
    const eventStore = makeTaskEventStore({ rootDir, coordinator: makeJournaledWriteCoordinator({ rootDir }) });
    const projection = makeTaskProjection({ rootDir, eventStore });
    const leases = makeTaskLeaseStore({ rootDir, now: () => "2026-08-11T00:00:00.000Z" });
    const service = makeTaskLifecycleService({ eventStore, projection, leases });
    const create = {
      type: "CreateReplayTask" as const, taskId: "task-1", title: "Replay task", graph: replayGraph,
      completionGateIds: [], actor, opId: "op-create", eventId: "event-create", workspaceRevision: 1,
      occurredAt: "2026-08-11T00:00:00.000Z"
    };
    const createProof = { taskIdUnique: true as const, actorBinding: actor };
    const created = await service.execute(create, createProof);

    assert.equal(created.status, "applied");
    assert.equal((await service.execute(create, createProof)).revision, 1);
    assert.equal(Object.isFrozen(created.writePlan), true);
    assert.equal(Object.isFrozen(created.writePlan.targets), true);
    await assert.rejects(service.execute({ ...create, title: "Different" }, createProof), TaskLifecycleOperationConflict);

    const started = await service.execute({
      type: "StartExecution", taskId: "task-1", executionId: "execution-1", actor,
      opId: "op-start", eventId: "event-start", workspaceRevision: 2,
      occurredAt: "2026-08-11T00:01:00.000Z"
    }, {
      actorBinding: actor, expectedRevision: 1,
      reservation: { taskId: "task-1", executionId: "execution-1", credentialHash: "credential-hash", expiresAt: "2026-08-11T01:00:00.000Z", version: 0 }
    });

    assert.equal(started.status, "applied");
    assert.equal(started.snapshot.lease?.phase, "active");
    assert.equal(started.snapshot.executions[0]?.state, "active");
    assert.equal(JSON.stringify(eventStore.read().events).includes("credential-hash"), false);
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test("transition service replays reject through a new Execution before completion", async () => {
  const harness = lifecycleHarness();
  try {
    await harness.create();
    await harness.start("execution-1");
    await harness.submit("execution-1");
    await harness.review("execution-1", "anti_entropy", "changes_requested");
    await harness.start("execution-2");
    await harness.submit("execution-2");
    await harness.review("execution-2", "anti_entropy", "approved");
    await harness.review("execution-2", "acceptance", "approved");
    const completed = await harness.complete("execution-2");

    assert.equal(completed.snapshot.task?.status, "done");
    assert.equal(completed.snapshot.task?.iteration, 1);
    assert.deepEqual(completed.snapshot.executions.map((execution) => execution.state), ["changes_requested", "accepted"]);
    assert.deepEqual(completed.snapshot.edgesTaken.map((edge) => edge.on), ["submitted", "changes_requested", "submitted", "approved"]);
  } finally {
    harness.cleanup();
  }
});
