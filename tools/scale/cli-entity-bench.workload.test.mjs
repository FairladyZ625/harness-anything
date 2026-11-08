// harness-test-tier: fast

import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { benchContext } from "./cli-entity-bench.workload.mjs";

// `ha task create` prints the workspace spelling (`harness/tasks/...`); the benchmark's on-disk
// helpers must resolve that spelling from the workspace root once. Re-joining `harness/` produced
// `harness/harness/tasks/...`: plan/report reads threw ENOENT and closeout landed in a package that
// never exists.
test("benchmark helpers write plan, report and review bytes under the workspace package path", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "ha-bench-workload-"));
  try {
    const context = benchContext({ root, parent: root }, 1, [], 1);
    context.got.set("task-create#0", { workspacePackagePath: "harness/tasks/task-bench-cli" });
    const packageDir = path.join(root, "harness", "tasks", "task-bench-cli");
    mkdirSync(packageDir, { recursive: true });

    const plan = context.realizePlan(0);
    assert.equal(plan, "harness/tasks/task-bench-cli/task_plan.md");
    assert.equal(existsSync(path.join(root, plan)), true);

    context.writeCloseout(0);
    assert.equal(existsSync(path.join(packageDir, "closeout.md")), true);
    assert.equal(existsSync(path.join(packageDir, "artifacts", "report.md")), true);

    const reviewed = context.review(0);
    assert.deepEqual(reviewed.evidenceChecked, ["harness/tasks/task-bench-cli/artifacts/report.md"]);
    assert.equal(existsSync(path.join(packageDir, "artifacts", "reports", "rev-0.md")), true);
    assert.equal(existsSync(path.join(root, "harness", "harness")), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
