// harness-test-tier: integration
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { unwrapCommandReceipt } from "./helpers/receipt.ts";
import { cliTestEnv } from "./helpers/cli-test-env.ts";

const cliEntry = path.resolve("packages/cli/src/index.ts");
const taskId = "task_01KWY3Z4VEVP6FNT28ZFA809GW";

test("worktree create writes a task binding and status reports active", () => {
  withGitHarnessRoot((rootDir) => {
    const created = runJson(rootDir, ["worktree", "create", "--task", taskId, "--agent", "codex", "--base", "HEAD"]);

    assert.equal(created.ok, true);
    assert.equal(created.command, "worktree-create");
    assert.equal(created.taskId, taskId);
    assert.equal(created.report.status, "active");
    assert.equal(created.report.branchName, "codex/worktree-binding-command-and-enforcement");
    assert.equal(created.path, ".worktrees/worktree-binding-command-and-enforcement");
    assert.equal(existsSync(path.join(rootDir, created.path)), true);

    const bindingPath = path.join(rootDir, ".harness/generated/worktree-bindings", `${taskId}.json`);
    const binding = JSON.parse(readFileSync(bindingPath, "utf8")) as Record<string, unknown>;
    assert.equal(binding.taskId, taskId);
    assert.equal(binding.branchName, "codex/worktree-binding-command-and-enforcement");
    assert.equal(binding.baseRef, "HEAD");

    const status = runJson(rootDir, ["worktree", "status", "--task", taskId]);
    assert.equal(status.ok, true);
    assert.equal(status.command, "worktree-status");
    assert.equal(status.report.status, "active");
    assert.deepEqual(status.report.blockers, []);
  });
});

test("worktree create fails closed without explicit or runtime namespace", () => {
  withGitHarnessRoot((rootDir) => {
    const result = runJson(rootDir, ["worktree", "create", "--task", taskId, "--base", "HEAD"], false, {});

    assert.equal(result.ok, false);
    assert.equal(result.error.code, "invalid_worktree_namespace");
    assert.equal(existsSync(path.join(rootDir, ".worktrees/worktree-binding-command-and-enforcement")), false);
  });
});

test("worktree status reports a missing binding with a repair command", () => {
  withGitHarnessRoot((rootDir) => {
    const result = runJson(rootDir, ["worktree", "status", "--task", taskId], false);

    assert.equal(result.ok, false);
    assert.equal(result.command, "worktree-status");
    assert.equal(result.error.code, "worktree_binding_missing");
    assert.equal(result.report.status, "missing");
    assert.equal(result.report.blockers[0].includes("ha worktree create --task"), true);
  });
});

function withGitHarnessRoot<T>(fn: (rootDir: string) => T): T {
  const rootDir = mkdtempSync(path.join(tmpdir(), "ha-worktree-cli-"));
  try {
    mkdirSync(path.join(rootDir, "harness/tasks", `${taskId}-worktree-binding-command-and-enforcement`), { recursive: true });
    writeFileSync(path.join(rootDir, "harness", "harness.yaml"), "schema: harness-anything/v1\nlayout:\n  authoredRoot: harness\n", "utf8");
    writeFileSync(path.join(rootDir, ".gitignore"), ".harness/\n.worktrees/\n", "utf8");
    writeFileSync(path.join(rootDir, "harness/tasks", `${taskId}-worktree-binding-command-and-enforcement`, "INDEX.md"), `---\nschema: task-package/v2\ntask_id: ${taskId}\ntitle: Worktree binding command and enforcement\n---\n\n# Worktree binding command and enforcement\n`, "utf8");
    git(rootDir, ["init"]);
    git(rootDir, ["config", "user.email", "test@example.com"]);
    git(rootDir, ["config", "user.name", "Test User"]);
    git(rootDir, ["add", "."]);
    git(rootDir, ["commit", "-m", "fixture"]);
    return fn(rootDir);
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
}

function git(cwd: string, args: ReadonlyArray<string>): string {
  return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}

function runJson(
  rootDir: string,
  args: ReadonlyArray<string>,
  expectSuccess = true,
  env: Readonly<Record<string, string>> = {}
): Record<string, any> {
  try {
    const stdout = execFileSync(process.execPath, [cliEntry, "--root", rootDir, "--json", ...args], {
      encoding: "utf8",
      env: cliTestEnv({ ...env })
    });
    return unwrapCommandReceipt(JSON.parse(stdout) as Record<string, any>);
  } catch (error) {
    if (expectSuccess) throw error;
    const failure = error as { readonly stdout?: string };
    return unwrapCommandReceipt(JSON.parse(failure.stdout ?? "{}") as Record<string, any>);
  }
}
