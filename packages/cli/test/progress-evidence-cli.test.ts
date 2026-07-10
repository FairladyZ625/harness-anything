import assert from "node:assert/strict";
import { withTestHarnessRoot as withTempRoot } from "./helpers/git-fixtures.ts";
import { unwrapCommandReceipt } from "./helpers/receipt.ts";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";

const cliEntry = path.resolve("packages/cli/src/index.ts");
const taskIdPattern = /^task_[0123456789ABCDEFGHJKMNPQRSTVWXYZ]{26}$/u;

test("CLI appends every repeated progress evidence entry", () => {
  withTempRoot((rootDir) => {
    const created = runJson(rootDir, ["new-task", "--title", "Task One"]);
    const taskId = assertGeneratedTaskId(created.taskId);

    const result = runJson(rootDir, [
      "task", "progress", "append", taskId, "--text", "Implemented local CLI",
      "--evidence", "log:artifacts/check.log:passed",
      "--evidence", "test:artifacts/unit.log:green"
    ]);
    const progress = readFileSync(path.join(rootDir, `harness/tasks/${taskId}-task-one/progress.md`), "utf8");

    assert.equal(result.ok, true);
    assert.match(progress, /Evidence: log:artifacts\/check\.log:passed/);
    assert.match(progress, /Evidence: test:artifacts\/unit\.log:green/);
  });
});

function assertGeneratedTaskId(value: unknown): string {
  assert.equal(typeof value, "string");
  assert.match(value, taskIdPattern);
  return value;
}

function runJson(rootDir: string, args: ReadonlyArray<string>): Record<string, any> {
  const stdout = execFileSync(process.execPath, [cliEntry, "--root", rootDir, "--json", ...args], {
    encoding: "utf8",
    env: { ...process.env, HARNESS_ACTOR: "agent:test" }
  });
  return unwrapCommandReceipt(JSON.parse(stdout) as Record<string, any>);
}
