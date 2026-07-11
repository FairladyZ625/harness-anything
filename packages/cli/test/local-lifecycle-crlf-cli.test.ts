// harness-test-tier: integration
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { ensureTestHarnessIdentity } from "./helpers/git-fixtures.ts";
import { unwrapCommandReceipt } from "./helpers/receipt.ts";
import { writeSubstantiveTaskPlan } from "./helpers/task-plan-fixture.ts";

const cliEntry = path.resolve("packages/cli/src/index.ts");
const taskIdPattern = /^task_[0123456789ABCDEFGHJKMNPQRSTVWXYZ]{26}$/u;

test("CLI lifecycle commands recognize task packages with Windows CRLF frontmatter", () => {
  withTempRoot((rootDir) => {
    const created = runJson(rootDir, [
      "task",
      "create",
      "--title",
      "测试任务",
      "--kind",
      "fix",
      "--risk-tier",
      "medium",
      "--urgency",
      "high",
      "--locale",
      "zh-CN"
    ]);
    const taskId = assertGeneratedTaskId(created.taskId);
    writeSubstantiveTaskPlan(rootDir, String(created.packagePath));
    const indexPath = path.join(rootDir, String(created.packagePath), "INDEX.md");
    writeFileSync(indexPath, readFileSync(indexPath, "utf8").replace(/\n/gu, "\r\n"), "utf8");
    rmSync(path.join(rootDir, ".harness/cache/projections.sqlite"), { force: true });

    const list = runJson(rootDir, ["task", "list", "--include-archived"]);
    assert.equal(list.ok, true);
    assert.equal(list.tasks.some((task: Record<string, unknown>) => task.taskId === taskId), true);
    assert.equal(list.warnings.some(isFrontmatterMissingWarning), false);

    const status = runJson(rootDir, ["status"]);
    assert.equal(status.ok, true);
    assert.equal(status.summary.taskCount, 1);
    assert.equal(status.warnings.some(isFrontmatterMissingWarning), false);

    const check = runJson(rootDir, ["check", "--profile", "target-project"], false);
    assert.equal(check.warnings.some(isFrontmatterMissingWarning), false);

    const transitioned = runJson(rootDir, ["task", "transition", taskId, "active", "--reason", "work started"]);
    assert.equal(transitioned.ok, true);
    assert.equal(transitioned.status, "active");

    const progress = runJson(rootDir, ["task", "progress", "append", taskId, "--text", "test progress"]);
    assert.equal(progress.ok, true);
  });
});

function assertGeneratedTaskId(value: unknown): string {
  assert.equal(typeof value, "string");
  assert.match(value, taskIdPattern);
  return value;
}

function isFrontmatterMissingWarning(warning: Record<string, unknown>): boolean {
  return warning.code === "source_malformed"
    || warning.code === "task_index_frontmatter_missing"
    || String(warning.message ?? "").includes("INDEX.md missing frontmatter");
}

function withTempRoot<T>(fn: (rootDir: string) => T): T {
  const rootDir = mkdtempSync(path.join(tmpdir(), "ha-cli-crlf-"));
  try {
    ensureTestHarnessIdentity(rootDir);
    return fn(rootDir);
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
}

function runJson(rootDir: string, args: ReadonlyArray<string>, expectSuccess = true): Record<string, any> {
  try {
    const stdout = execFileSync(process.execPath, [cliEntry, "--root", rootDir, "--json", ...args], {
      encoding: "utf8"
    });
    return unwrapCommandReceipt(JSON.parse(stdout) as Record<string, any>);
  } catch (error) {
    if (expectSuccess) throw error;
    const failure = error as { readonly stdout?: string };
    return unwrapCommandReceipt(JSON.parse(failure.stdout ?? "{}") as Record<string, any>);
  }
}
