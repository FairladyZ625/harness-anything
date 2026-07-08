import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import path from "node:path";
import { Effect } from "effect";
import { taskEntityId } from "../../src/domain/index.ts";
import { makeJournaledWriteCoordinator } from "../../src/store/index.ts";
import { docWrite, withTempStore } from "./helpers.ts";

test("WriteCoordinator accepts duplicate op ids idempotently", () => {
  withTempStore((rootDir) => {
    const coordinator = makeJournaledWriteCoordinator({ rootDir });
    const op = docWrite("op-1", "task-1", "progress.md", "first");

    assert.equal(Effect.runSync(coordinator.enqueue(op)).accepted, true);
    assert.equal(Effect.runSync(coordinator.enqueue(op)).accepted, true);

    const report = Effect.runSync(coordinator.flush("explicit"));
    assert.equal(report.opCount, 1);
    assert.equal(readFileSync(path.join(rootDir, "harness/tasks/task-1/progress.md"), "utf8"), "first");
  });
});

test("WriteCoordinator reports duplicate batch write conflicts on the conflicting write task", () => {
  withTempStore((rootDir) => {
    const coordinator = makeJournaledWriteCoordinator({ rootDir });
    Effect.runSync(coordinator.enqueue({
      opId: "op-batch-duplicate",
      entityId: taskEntityId("task-batch"),
      kind: "package_supersede",
      payload: {
        writes: [
          { taskId: "task-conflict", path: "INDEX.md", body: "first" },
          { taskId: "task-conflict", path: "INDEX.md", body: "second" }
        ]
      }
    }));

    const result = Effect.runSync(Effect.either(coordinator.flush("explicit")));

    assert.equal(result._tag, "Left");
    if (result._tag === "Left") {
      assert.deepEqual(result.left, {
        _tag: "WriteRejected",
        taskId: "task-conflict",
        entityId: "task/task-conflict",
        reason: "duplicate batch write target: INDEX.md"
      });
    }
  });
});
