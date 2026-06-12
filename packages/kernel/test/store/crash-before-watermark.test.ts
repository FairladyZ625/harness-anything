import assert from "node:assert/strict";
import test from "node:test";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { Effect } from "effect";
import { makeJournaledWriteCoordinator } from "../../src/store/index.ts";
import { docWrite, withTempStore } from "./helpers.ts";

test("WriteCoordinator recovers queued journal entries after crash before watermark", () => {
  withTempStore((rootDir) => {
    const firstCoordinator = makeJournaledWriteCoordinator({ rootDir });
    Effect.runSync(firstCoordinator.enqueue(docWrite("op-1", "task-1", "progress.md", "replayed")));

    assert.equal(existsSync(path.join(rootDir, ".harness/write-journal/watermark.json")), false);

    const recoveredCoordinator = makeJournaledWriteCoordinator({ rootDir });
    const report = Effect.runSync(recoveredCoordinator.recover);

    assert.equal(report.replayedOps, 1);
    assert.equal(report.recoveredWatermark, "op-1");
    assert.equal(readFileSync(path.join(rootDir, "harness/planning/tasks/task-1/progress.md"), "utf8"), "replayed");
  });
});
