// harness-test-tier: integration
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { Effect } from "effect";
import {
  makeJournaledWriteCoordinator,
  makeLocalVersionControlSystem,
  taskEntityId,
  type WriteError,
  type WriteOp
} from "../../src/index.ts";
import { testWriteAttribution } from "../test-attribution.ts";
import { withTempStore } from "./helpers.ts";

test("WriteCoordinator reserves completion-evidence.json for typed commit completion", () => {
  withTempStore((rootDir) => {
    const coordinator = makeJournaledWriteCoordinator({ attribution: testWriteAttribution(), rootDir });
    const genericFailure = runWriteFailure(coordinator.enqueue(documentWrite()));
    assert.equal(genericFailure._tag, "WriteRejected");
    assert.match(genericFailure.reason, /immutable machine evidence/u);
    assert.match(genericFailure.reason, /ha task complete task-1 --commit-anchor/u);
  });
});

test("WriteCoordinator rejects task-tree staging with hand-written completion evidence", () => {
  withTempStore((rootDir) => {
    const taskRoot = path.join(rootDir, "harness/tasks/task-1");
    mkdirSync(taskRoot, { recursive: true });
    writeFileSync(path.join(taskRoot, "closeout.md"), "# Closeout\n", "utf8");
    const local = makeLocalVersionControlSystem();
    const harnessRoot = path.join(rootDir, "harness");
    const coordinator = makeJournaledWriteCoordinator({
      attribution: testWriteAttribution(), rootDir,
      versionControlSystem: {
        ...local,
        normalizePath: (inputPath) => path.resolve(inputPath),
        topLevel: (inputPath) => path.resolve(inputPath).startsWith(harnessRoot) ? harnessRoot : rootDir,
        isIgnored: () => false,
        workingTreeFiles: () => "?? tasks/task-1/completion-evidence.json\n"
      }
    });
    const failure = runWriteFailure(coordinator.enqueue({
      opId: "stage-raw-completion-evidence",
      entityId: taskEntityId("task-1"),
      kind: "task_tree_stage",
      payload: { scope: "task-package" }
    }));
    assert.equal(failure._tag, "WriteRejected");
    assert.match(failure.reason, /immutable machine evidence/u);
  });
});

function documentWrite(): WriteOp {
  return {
    opId: "raw-completion-evidence",
    entityId: taskEntityId("task-1"),
    kind: "doc_write",
    payload: { path: "completion-evidence.json", body: "{}" }
  };
}

function runWriteFailure<A>(effect: Effect.Effect<A, WriteError>): WriteError {
  const result = Effect.runSync(Effect.either(effect));
  assert.equal(result._tag, "Left");
  return result.left;
}
