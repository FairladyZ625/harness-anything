import assert from "node:assert/strict";
import test from "node:test";
import { rmSync } from "node:fs";
import path from "node:path";
import { Effect } from "effect";
import { makeJournaledWriteCoordinator, makeMarkdownArtifactStore } from "../../src/store/index.ts";
import { docWrite, withTempStore } from "./helpers.ts";

test("markdown artifact store remains the rebuildable source of truth without SQLite", () => {
  withTempStore((rootDir) => {
    const coordinator = makeJournaledWriteCoordinator({ rootDir });
    Effect.runSync(coordinator.enqueue(docWrite("op-1", "task-1", "task_plan.md", "# Task")));
    Effect.runSync(coordinator.flush("explicit"));

    rmSync(path.join(rootDir, ".projection.sqlite"), { force: true });

    const store = makeMarkdownArtifactStore({ rootDir });
    const taskPackage = Effect.runSync(store.readTaskPackage("task-1"));

    assert.equal(taskPackage.disposition, "active");
    assert.deepEqual(taskPackage.documents.map((document) => document.path), ["task_plan.md"]);
    assert.equal(taskPackage.documents[0]?.body, "# Task");
  });
});
