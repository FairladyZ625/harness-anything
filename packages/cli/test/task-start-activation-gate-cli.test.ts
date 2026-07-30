// harness-test-tier: integration
import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { runJson, withTempRoot } from "./helpers/task-document-gates-fixtures.ts";

test("CLI task start rejects a scaffold plan before reserving a lease or publishing an Execution", () => {
  withTempRoot((rootDir) => {
    const created = runJson(rootDir, [
      "task", "create", "--title", "Atomic Scaffold Start",
      "--vertical", "software/coding", "--preset", "standard-task"
    ]);

    const blocked = runJson(rootDir, ["task", "start", created.taskId], false);

    assert.equal(blocked.ok, false);
    assert.equal(blocked.error?.code, "task_plan_placeholder");
    assert.equal(blocked.status, "planned");
    assert.match(
      readFileSync(path.join(rootDir, created.packagePath, "INDEX.md"), "utf8"),
      /^  status: planned$/mu
    );
    assert.equal(
      existsSync(path.join(rootDir, ".harness", "task-holders", `${created.taskId}.json`)),
      false
    );
    const executionsRoot = path.join(rootDir, created.packagePath, "executions");
    assert.equal(existsSync(executionsRoot) ? readdirSync(executionsRoot).length : 0, 0);
  });
});
