// harness-test-tier: fast
import assert from "node:assert/strict";
import test from "node:test";
import { lifecycleFixture } from "../store/task-lifecycle-fixture.ts";
import {
  applyTransition,
  reduceTaskEvent,
  emptyTaskLifecycleSnapshot,
  normalizeTaskLifecycleCommand,
  serializeTaskEvent,
} from "../../src/domain/task-lifecycle.contract.ts";
import { isNativeExecution } from "../../src/domain/execution.ts";

test("offline retirement releases an in-flight Task, preserves acceptance history and cold replays", () => {
  const fixture = lifecycleFixture();
  for (const count of [2, 3]) {
    const prefix = fixture.events.slice(0, count);
    const snapshot = prefix.reduce(reduceTaskEvent, emptyTaskLifecycleSnapshot());
    const current = snapshot.executions[0]!;
    assert.ok(isNativeExecution(current));
    const command = {
      ...normalizeTaskLifecycleCommand(
        {
          workspaceId: "workspace-1",
          actor: snapshot.task!.createdBy,
          source: "local",
          expectedRevision: snapshot.revision,
        },
        {
          type: "RetireCompletionGeneration",
          taskId: snapshot.task!.taskId,
          executionId: current.executionId,
          sourceGeneration: 2,
        } as const,
      ),
      eventId: "offline-retirement",
      workspaceRevision: snapshot.revision + 1,
      occurredAt: "2026-10-10T00:00:00.000Z",
    };
    const result = applyTransition(snapshot, command, {});
    serializeTaskEvent(result.event);
    assert.equal(result.snapshot.executions[0]!.state, "abandoned");
    assert.equal(result.snapshot.task!.iteration, current.iteration + 1);
    assert.equal(result.snapshot.task!.currentNode, "implementation");
    assert.equal(result.snapshot.lease, null);
    assert.deepEqual(result.snapshot.reviews, snapshot.reviews);
    assert.deepEqual(result.snapshot.consents, snapshot.consents);
    assert.deepEqual([...prefix, result.event].reduce(reduceTaskEvent, emptyTaskLifecycleSnapshot()), result.snapshot);
    assert.throws(() =>
      applyTransition(
        fixture.snapshot,
        { ...command, expectedRevision: fixture.snapshot.revision, workspaceRevision: fixture.snapshot.revision + 1 },
        {},
      ),
    );
  }
});
