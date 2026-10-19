// harness-test-tier: fast
import assert from "node:assert/strict";
import test from "node:test";
import { parseDaemonRpcParams } from "@harness-anything/daemon/internal/protocol/daemon-protocol-rpc-validation";
import { parseThinCommand, renderThinHelp } from "../src/cli/thin-command.ts";

const prAction = (args: readonly string[]) => {
  const parsed = parseThinCommand(["task", "pr", ...args]);
  assert.equal(parsed.ok, true, JSON.stringify(parsed));
  return parsed.ok ? (parsed.command.action as Record<string, unknown>) : undefined;
};

test("task pr --wait-ci parses as a wait-mode publication without a title", () => {
  assert.deepEqual(prAction(["task-x", "--wait-ci"]), {
    kind: "task-pr",
    taskId: "task-x",
    waitCi: true,
  });
});

test("task pr --wait-ci --timeout maps minutes into timeoutMinutes", () => {
  assert.deepEqual(prAction(["task-x", "--wait-ci", "--timeout", "30"]), {
    kind: "task-pr",
    taskId: "task-x",
    waitCi: true,
    timeoutMinutes: 30,
  });
  assert.deepEqual(prAction(["task-x", "--wait-ci", "--timeout=5"]), {
    kind: "task-pr",
    taskId: "task-x",
    waitCi: true,
    timeoutMinutes: 5,
  });
});

test("task pr --wait-ci refuses PR-authoring flags and --timeout requires the wait", () => {
  assert.equal(parseThinCommand(["task", "pr", "task-x", "--wait-ci", "--title", "fix(x): y"]).ok, false);
  assert.equal(parseThinCommand(["task", "pr", "task-x", "--wait-ci", "--update"]).ok, false);
  assert.equal(parseThinCommand(["task", "pr", "task-x", "--timeout", "30"]).ok, false);
  assert.equal(parseThinCommand(["task", "pr", "task-x", "--wait-ci", "--timeout", "0"]).ok, false);
  assert.equal(parseThinCommand(["task", "pr", "task-x", "--wait-ci", "--timeout", "abc"]).ok, false);
});

test("task pr without --wait-ci still requires a conventional title", () => {
  assert.equal(parseThinCommand(["task", "pr", "task-x"]).ok, false);
  const action = prAction(["task-x", "--title", "fix(daemon): publish task PR"]);
  assert.equal(action.title, "fix(daemon): publish task PR");
  assert.equal(action.waitCi, undefined);
});

test("the task-pr help text names --wait-ci and its three exit codes", () => {
  const help = renderThinHelp([], "task");
  assert.match(help, /ha task pr <task-id> \[--update\] \[--title <title>\] \[--wait-ci\] \[--timeout <timeout>\]/u);
  assert.match(help, /--wait-ci — block until the pull request's checks finish; exit 0 green, 1 failed, 2 timeout/u);
  assert.match(help, /--timeout — minutes to wait before giving up \(default 60\); optional; value/u);
  assert.match(help, /requires: --wait-ci/u);
});

test("the repo.task.run wire accepts the wait action fields", () => {
  const params = (action: Record<string, unknown>) => ({
    repo: { repoId: "repo" },
    payload: { action },
  });
  assert.equal(
    parseDaemonRpcParams(
      "repo.task.run",
      params({ kind: "task-pr", taskId: "task-x", waitCi: true, timeoutMinutes: 30 }),
    ).ok,
    true,
  );
});
