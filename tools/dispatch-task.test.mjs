// harness-test-tier: fast

import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { DispatchCommandError, parseDispatchArgs, runDispatch } from "./dispatch-task.mjs";
import { realizedTaskPlan } from "./fixtures/task-plan.mjs";

const taskId = "task_receipt_truth",
  executionId = "exe_receipt_truth";
const packagePath = "tasks/server-returned-path-no-guessed-slug";
const dispatchId = `dispatch_${"a".repeat(24)}`,
  runtimeSessionId = "runtime_receipt_truth";

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
    return {
      command: ["ha", ...args],
      receipt: { ok: true, dispatchId, runtimeSessionId, nextAction: `ha runtime status ${runtimeSessionId} --wait` },
    };
  };
  return { calls, run };
}

test("dispatch driver walks create, returned package path, start, detach, and foreground wait handoff", () => {
  const workspaceRoot = mkdtempSync(path.join(os.tmpdir(), "ha-dispatch-dry-"));
  const planFile = path.join(workspaceRoot, "caller-plan.md");
  writeFileSync(planFile, realizedTaskPlan("Caller-authored plan"), "utf8");
  const fixture = successfulRunner(workspaceRoot);
  try {
    const receipt = runDispatch(
      { planFile, preset: "standard-task", title: "A title whose slug must not be guessed", instance: "codex-worker" },
      { workspaceRoot, run: fixture.run },
    );
    assert.equal(readFileSync(receipt.planPath, "utf8"), readFileSync(planFile, "utf8"));
    assert.equal(receipt.packagePath, packagePath);
    assert.equal(receipt.planPath, path.join(workspaceRoot, "harness", ...packagePath.split("/"), "task_plan.md"));
    assert.equal(
      existsSync(path.join(workspaceRoot, "harness", "tasks", "a-title-whose-slug-must-not-be-guessed")),
      false,
    );
    assert.deepEqual(fixture.calls, [
      {
        step: "task-create",
        args: ["task", "create", "--title", "A title whose slug must not be guessed", "--preset", "standard-task"],
      },
      { step: "task-start", args: ["task", "start", taskId] },
      { step: "runtime-run", args: ["runtime", "run", "codex-worker", "--task", taskId, "--detach"] },
    ]);
    assert.deepEqual(
      receipt.steps.map((step) => step.step),
      ["task-create", "plan-write", "task-start", "runtime-run"],
    );
    assert.equal(receipt.schema, "dispatch-task-receipt/v2");
    assert.equal(
      receipt.dispatchJsonlPath,
      path.join(workspaceRoot, ".harness", "runtime", "dispatches", `${dispatchId}.jsonl`),
    );
    assert.equal(receipt.nextAction, `ha runtime status ${runtimeSessionId} --wait`);
    assert.equal("sentinelCommand" in receipt, false);
  } finally {
    rmSync(workspaceRoot, { recursive: true, force: true });
  }
});

test("task create receipt without packagePath stops instead of guessing a package directory", () => {
  const workspaceRoot = mkdtempSync(path.join(os.tmpdir(), "ha-dispatch-no-path-"));
  const planFile = path.join(workspaceRoot, "plan.md");
  writeFileSync(planFile, realizedTaskPlan("Missing package path"), "utf8");
  const fixture = successfulRunner(workspaceRoot, {
    "task-create": ({ args }) => ({ command: ["ha", ...args], receipt: { ok: true, taskId } }),
  });
  try {
    assert.throws(
      () =>
        runDispatch(
          { planFile, preset: "standard-task", title: "Never guess me", instance: "codex-worker" },
          { workspaceRoot, run: fixture.run },
        ),
      /receipt has no packagePath; refusing to infer/u,
    );
    assert.deepEqual(
      fixture.calls.map((call) => call.step),
      ["task-create"],
    );
  } finally {
    rmSync(workspaceRoot, { recursive: true, force: true });
  }
});

test("optional prompt file is validated before create and forwarded to runtime", () => {
  const workspaceRoot = mkdtempSync(path.join(os.tmpdir(), "ha-dispatch-prompt-"));
  const planFile = path.join(workspaceRoot, "plan.md"),
    promptFile = path.join(workspaceRoot, "prompt.md");
  writeFileSync(planFile, realizedTaskPlan("Prompt dispatch"), "utf8");
  writeFileSync(promptFile, "Use the supplied worker posture.\n", "utf8");
  const fixture = successfulRunner(workspaceRoot);
  try {
    runDispatch(
      { planFile, promptFile, preset: "standard-task", title: "Prompt dispatch", instance: "codex-worker" },
      { workspaceRoot, run: fixture.run },
    );
    assert.deepEqual(fixture.calls.at(-1).args, [
      "runtime",
      "run",
      "codex-worker",
      "--task",
      taskId,
      "--detach",
      "--prompt-file",
      promptFile,
    ]);
  } finally {
    rmSync(workspaceRoot, { recursive: true, force: true });
  }
});

test("lifecycle rejection is rethrown unchanged and runtime is not dispatched", () => {
  const workspaceRoot = mkdtempSync(path.join(os.tmpdir(), "ha-dispatch-gate-"));
  const planFile = path.join(workspaceRoot, "plan.md");
  writeFileSync(planFile, realizedTaskPlan("Rejected dispatch"), "utf8");
  const rejection = new DispatchCommandError(
    ["ha", "task", "start"],
    1,
    JSON.stringify({ ok: false, code: "task_wip_limit_reached" }),
    "",
  );
  const fixture = successfulRunner(workspaceRoot, {
    "task-start": () => {
      throw rejection;
    },
  });
  try {
    assert.throws(
      () =>
        runDispatch(
          { planFile, preset: "standard-task", title: "Rejected dispatch", instance: "codex-worker" },
          { workspaceRoot, run: fixture.run },
        ),
      (error) => error === rejection && error.stdout.includes("task_wip_limit_reached"),
    );
    assert.deepEqual(
      fixture.calls.map((call) => call.step),
      ["task-create", "task-start"],
    );
  } finally {
    rmSync(workspaceRoot, { recursive: true, force: true });
  }
});

test("runtime receipt without nextAction stops instead of recreating a shell monitor", () => {
  const workspaceRoot = mkdtempSync(path.join(os.tmpdir(), "ha-dispatch-no-next-"));
  const planFile = path.join(workspaceRoot, "plan.md");
  writeFileSync(planFile, realizedTaskPlan("Missing next action"), "utf8");
  const fixture = successfulRunner(workspaceRoot, {
    "runtime-run": ({ args }) => ({ command: ["ha", ...args], receipt: { ok: true, dispatchId, runtimeSessionId } }),
  });
  try {
    assert.throws(
      () =>
        runDispatch(
          { planFile, preset: "standard-task", title: "Missing next action", instance: "codex-worker" },
          { workspaceRoot, run: fixture.run },
        ),
      /runtime run receipt has no nextAction/u,
    );
    assert.equal(fixture.calls.at(-1).step, "runtime-run");
  } finally {
    rmSync(workspaceRoot, { recursive: true, force: true });
  }
});

test(
  "returned completion action cannot orphan a background shell",
  { skip: process.platform === "win32" ? "requires POSIX process-table and shell semantics" : false },
  () => {
    const directory = mkdtempSync(path.join(os.tmpdir(), "ha-dispatch-wait-"));
    const planFile = path.join(directory, "plan.md"),
      bin = path.join(directory, "bin"),
      ha = path.join(bin, "ha");
    writeFileSync(planFile, realizedTaskPlan("Wait handoff"), "utf8");
    mkdirSync(bin);
    writeFileSync(ha, "#!/usr/bin/env node\nprocess.exit(0);\n", "utf8");
    chmodSync(ha, 0o755);
    const fixture = successfulRunner(directory);
    try {
      const receipt = runDispatch(
        { planFile, preset: "standard-task", title: "Wait handoff", instance: "codex-worker" },
        { workspaceRoot: directory, run: fixture.run },
      );
      assert.deepEqual(processRowsContaining(runtimeSessionId), []);
      const result = spawnSync("sh", ["-c", receipt.nextAction], {
        encoding: "utf8",
        env: { ...process.env, PATH: `${bin}${path.delimiter}${process.env.PATH ?? ""}` },
      });
      assert.equal(result.status, 0, result.stderr);
      assert.deepEqual(processRowsContaining(runtimeSessionId), []);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  },
);

test("CLI arguments and help expose exactly the supported judgment inputs", () => {
  assert.deepEqual(
    parseDispatchArgs([
      "--plan-file",
      "plan.md",
      "--preset",
      "standard-task",
      "--title",
      "Dispatch",
      "--instance",
      "codex-worker",
    ]),
    {
      help: false,
      planFile: "plan.md",
      preset: "standard-task",
      title: "Dispatch",
      instance: "codex-worker",
      promptFile: undefined,
    },
  );
  assert.equal(parseDispatchArgs(["--help"]).help, true);
  assert.throws(
    () => parseDispatchArgs(["--plan-file", "plan.md", "--preset", "standard-task", "--title", "Dispatch"]),
    /Usage:/u,
  );
  assert.throws(
    () =>
      parseDispatchArgs([
        "--plan-file",
        "plan.md",
        "--preset",
        "standard-task",
        "--title",
        "Dispatch",
        "--instance",
        "one",
        "--instance",
        "two",
      ]),
    /may be supplied once/u,
  );
});

function processRowsContaining(marker) {
  return spawnSync("ps", ["-axo", "pid=,ppid=,comm=,command="], { encoding: "utf8" })
    .stdout.split(/\r?\n/u)
    .filter((line) => line.includes(marker));
}
