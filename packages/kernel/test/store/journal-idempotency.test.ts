import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import path from "node:path";
import { Effect } from "effect";
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
    assert.equal(readFileSync(path.join(rootDir, "tasks/task-1/progress.md"), "utf8"), "first");
  });
});
