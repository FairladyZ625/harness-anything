import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import path from "node:path";
import { Effect } from "effect";
import { makeJournaledWriteCoordinator } from "../../src/store/index.ts";
import { docWrite, withTempStore } from "./helpers.ts";

test("WriteCoordinator flushes same-task writes in FIFO order", () => {
  withTempStore((rootDir) => {
    const coordinator = makeJournaledWriteCoordinator({ rootDir });

    Effect.runSync(coordinator.enqueue(docWrite("op-1", "task-1", "notes.md", "first")));
    Effect.runSync(coordinator.enqueue(docWrite("op-2", "task-1", "notes.md", "second")));

    const report = Effect.runSync(coordinator.flush("explicit"));
    assert.equal(report.watermark, "op-2");
    assert.equal(readFileSync(path.join(rootDir, "tasks/task-1/notes.md"), "utf8"), "second");
  });
});

test("WriteCoordinator preserves same-task FIFO across two coordinators", () => {
  withTempStore((rootDir) => {
    const firstCoordinator = makeJournaledWriteCoordinator({ rootDir });
    const secondCoordinator = makeJournaledWriteCoordinator({ rootDir });

    Effect.runSync(firstCoordinator.enqueue(docWrite("op-1", "task-1", "notes.md", "first")));
    Effect.runSync(secondCoordinator.enqueue(docWrite("op-2", "task-1", "notes.md", "second")));

    const secondReport = Effect.runSync(secondCoordinator.flush("explicit"));
    assert.equal(secondReport.opCount, 2);
    assert.equal(secondReport.watermark, "op-2");
    assert.equal(readFileSync(path.join(rootDir, "tasks/task-1/notes.md"), "utf8"), "second");

    const firstReport = Effect.runSync(firstCoordinator.flush("explicit"));
    assert.equal(firstReport.opCount, 0);
    assert.equal(readFileSync(path.join(rootDir, ".journal/watermark.json"), "utf8").includes("\"op-1\",\"op-2\""), true);
    assert.equal(readFileSync(path.join(rootDir, "tasks/task-1/notes.md"), "utf8"), "second");
  });
});
