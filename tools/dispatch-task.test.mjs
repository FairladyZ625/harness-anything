// harness-test-tier: fast

import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { DispatchCommandError, dispatchSentinelCommand, parseDispatchArgs, runDispatch, turnCompletedCountCommand } from "./dispatch-task.mjs";

const taskId = "task_receipt_truth", executionId = "exe_receipt_truth";
const packagePath = "tasks/server-returned-path-no-guessed-slug";
const dispatchId = `dispatch_${"a".repeat(24)}`, runtimeSessionId = "runtime_receipt_truth";

function successfulRunner(workspaceRoot, overrides = {}) {
  const calls = [];
  const run = ({ step, args }) => {
    calls.push({ step, args });
    if (overrides[step]) return overrides[step]({ step, args, calls });
    if (step === "task-create") {
      mkdirSync(path.join(workspaceRoot, "harness", ...packagePath.split("/")), { recursive: true });
      return { command: ["ha", ...args], receipt: { ok: true, taskId, packagePath } };
    }
    if (step === "task-start") return { command: ["ha", ...args], receipt: { ok: true, taskId, executionId } };
    return { command: ["ha", ...args], receipt: { ok: true, dispatchId, runtimeSessionId } };
  };
  return { calls, run };
}

test("dispatch driver walks create, returned package path, start, detach, and sentinel", () => {
  const workspaceRoot = mkdtempSync(path.join(os.tmpdir(), "ha-dispatch-dry-"));
  const planFile = path.join(workspaceRoot, "caller-plan.md");
  writeFileSync(planFile, "# Caller-authored plan\n\nDo the bounded work.\n", "utf8");
  const fixture = successfulRunner(workspaceRoot);
  try {
    const receipt = runDispatch({ planFile, preset: "standard-task", title: "A title whose slug must not be guessed", instance: "codex-worker" }, { workspaceRoot, run: fixture.run });
    assert.equal(readFileSync(receipt.planPath, "utf8"), readFileSync(planFile, "utf8"));
    assert.equal(receipt.packagePath, packagePath);
    assert.equal(receipt.planPath, path.join(workspaceRoot, "harness", ...packagePath.split("/"), "task_plan.md"));
    assert.equal(existsSync(path.join(workspaceRoot, "harness", "tasks", "a-title-whose-slug-must-not-be-guessed")), false);
    assert.deepEqual(fixture.calls, [
      { step: "task-create", args: ["task", "create", "--title", "A title whose slug must not be guessed", "--preset", "standard-task"] },
      { step: "task-start", args: ["task", "start", taskId] },
      { step: "runtime-run", args: ["runtime", "run", "codex-worker", "--task", taskId, "--detach"] },
    ]);
    assert.deepEqual(receipt.steps.map((step) => step.step), ["task-create", "plan-write", "task-start", "runtime-run", "sentinel"]);
    assert.equal(receipt.dispatchJsonlPath, path.join(workspaceRoot, ".harness", "runtime", "dispatches", `${dispatchId}.jsonl`));
    assert.equal(receipt.sentinelCommand, dispatchSentinelCommand(receipt.dispatchJsonlPath));
    assert.match(receipt.sentinelCommand, /turn\.completed/u);
    assert.match(receipt.sentinelCommand, /\) &$/u);
  } finally {
    rmSync(workspaceRoot, { recursive: true, force: true });
  }
});

test("task create receipt without packagePath stops instead of guessing a package directory", () => {
  const workspaceRoot = mkdtempSync(path.join(os.tmpdir(), "ha-dispatch-no-path-"));
  const planFile = path.join(workspaceRoot, "plan.md");
  writeFileSync(planFile, "# Plan\n", "utf8");
  const fixture = successfulRunner(workspaceRoot, {
    "task-create": ({ args }) => ({ command: ["ha", ...args], receipt: { ok: true, taskId } }),
  });
  try {
    assert.throws(
      () => runDispatch({ planFile, preset: "standard-task", title: "Never guess me", instance: "codex-worker" }, { workspaceRoot, run: fixture.run }),
      /receipt has no packagePath; refusing to infer/u,
    );
    assert.deepEqual(fixture.calls.map((call) => call.step), ["task-create"]);
  } finally {
    rmSync(workspaceRoot, { recursive: true, force: true });
  }
});

test("optional prompt file is validated before create and forwarded to runtime", () => {
  const workspaceRoot = mkdtempSync(path.join(os.tmpdir(), "ha-dispatch-prompt-"));
  const planFile = path.join(workspaceRoot, "plan.md"), promptFile = path.join(workspaceRoot, "prompt.md");
  writeFileSync(planFile, "# Plan\n", "utf8");
  writeFileSync(promptFile, "Use the supplied worker posture.\n", "utf8");
  const fixture = successfulRunner(workspaceRoot);
  try {
    runDispatch({ planFile, promptFile, preset: "standard-task", title: "Prompt dispatch", instance: "codex-worker" }, { workspaceRoot, run: fixture.run });
    assert.deepEqual(fixture.calls.at(-1).args, ["runtime", "run", "codex-worker", "--task", taskId, "--detach", "--prompt-file", promptFile]);
  } finally {
    rmSync(workspaceRoot, { recursive: true, force: true });
  }
});

test("lifecycle rejection is rethrown unchanged and runtime is not dispatched", () => {
  const workspaceRoot = mkdtempSync(path.join(os.tmpdir(), "ha-dispatch-gate-"));
  const planFile = path.join(workspaceRoot, "plan.md");
  writeFileSync(planFile, "# Plan\n", "utf8");
  const rejection = new DispatchCommandError(["ha", "task", "start"], 1, JSON.stringify({ ok: false, code: "task_wip_limit_reached" }), "");
  const fixture = successfulRunner(workspaceRoot, { "task-start": () => { throw rejection; } });
  try {
    assert.throws(
      () => runDispatch({ planFile, preset: "standard-task", title: "Rejected dispatch", instance: "codex-worker" }, { workspaceRoot, run: fixture.run }),
      (error) => error === rejection && error.stdout.includes("task_wip_limit_reached"),
    );
    assert.deepEqual(fixture.calls.map((call) => call.step), ["task-create", "task-start"]);
  } finally {
    rmSync(workspaceRoot, { recursive: true, force: true });
  }
});

test("turn.completed count is one clean integer for zero matches and a missing file", { skip: process.platform === "win32" ? "requires POSIX shell command semantics emitted by the sentinel" : false }, () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "ha-dispatch-sentinel-"));
  const emptyPath = path.join(directory, "empty.jsonl"), missingPath = path.join(directory, "missing.jsonl");
  writeFileSync(emptyPath, `${JSON.stringify({ type: "thread.started" })}\n`, "utf8");
  try {
    for (const target of [emptyPath, missingPath]) {
      const result = spawnSync("sh", ["-c", turnCompletedCountCommand(target)], { encoding: "utf8" });
      assert.equal(result.status, 0, result.stderr);
      assert.equal(result.stdout, "0\n");
    }
    writeFileSync(emptyPath, `${JSON.stringify({ event: { type: "turn.completed" } })}\n`, "utf8");
    assert.equal(spawnSync("sh", ["-c", turnCompletedCountCommand(emptyPath)], { encoding: "utf8" }).stdout, "1\n");
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("CLI arguments and help expose exactly the supported judgment inputs", () => {
  assert.deepEqual(parseDispatchArgs(["--plan-file", "plan.md", "--preset", "standard-task", "--title", "Dispatch", "--instance", "codex-worker"]), {
    help: false, planFile: "plan.md", preset: "standard-task", title: "Dispatch", instance: "codex-worker", promptFile: undefined,
  });
  assert.equal(parseDispatchArgs(["--help"]).help, true);
  assert.throws(() => parseDispatchArgs(["--plan-file", "plan.md", "--preset", "standard-task", "--title", "Dispatch"]), /Usage:/u);
  assert.throws(() => parseDispatchArgs(["--plan-file", "plan.md", "--preset", "standard-task", "--title", "Dispatch", "--instance", "one", "--instance", "two"]), /may be supplied once/u);
});
