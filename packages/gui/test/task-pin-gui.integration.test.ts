// harness-test-tier: integration
import assert from "node:assert/strict";
import test from "node:test";
import {
  parseDaemonGuiActionResponse,
  parseDaemonGuiReadResult,
} from "../../daemon/src/protocol/gui-result-validation.ts";
import { createLocalGuiServiceBridge } from "../src/index.ts";
import { startGuiResidentDaemonFixture } from "../test-support/resident-daemon.mjs";
import { restoreEnv } from "./service-bridge.fixtures.ts";

/**
 * GUI pin 的端到端判据:渲染层通过受控 preload 面发出的 pinTask/unpinTask 必须落在
 * 与 `ha task pin` 相同的 daemon 写路上——同一个 task-amend 动作、同一个 canonical
 * 台账字段,读回时 `repo.tasks.list` 与 `repo.agenda.read` 两面一致。
 */
test("GUI pin/unpin reach the ledger through the resident daemon write path", async () => {
  const fixture = await startGuiResidentDaemonFixture({
    daemonId: "gui-pin-integration",
    repoId: "gui-pin",
    task: { taskId: "task-gui-pin", title: "Resident GUI pin task" },
  });
  const previous = {
    userRoot: process.env.HARNESS_DAEMON_USER_ROOT,
    daemonId: process.env.HARNESS_DAEMON_ID,
    repoId: process.env.HARNESS_DAEMON_REPO_ID,
    endpoint: process.env.HARNESS_DAEMON_ENDPOINT,
  };
  // 宿主进程可能带着指向用户 default daemon 的注入端点;本测试只允许碰自己
  // 的临时 daemon,所以这里显式摘掉注入端点,结束再还原。
  delete process.env.HARNESS_DAEMON_ENDPOINT;
  Object.assign(process.env, fixture.env);
  try {
    const bridge = createLocalGuiServiceBridge(fixture.rootDir),
      scope = { repoId: fixture.repoId },
      taskSnapshot = async () =>
        parseDaemonGuiReadResult("repo.tasks.list", await bridge.invoke("getTasks", scope)).rows.find(
          (row) => row.taskId === "task-gui-pin",
        );
    assert.equal((await taskSnapshot())?.snapshot.task?.pinned ?? false, false, "a fresh task is not pinned");

    const pinned = parseDaemonGuiActionResponse(
      "repo.task.pin",
      await bridge.invoke("pinTask", { ...scope, taskId: "task-gui-pin" }),
    );
    assert.equal(pinned.ok, true, JSON.stringify(pinned));
    assert.equal(pinned.outcome, "applied");
    assert.equal((await taskSnapshot())?.snapshot.task?.pinned, true, "the pin must be visible in the task read");

    const agenda = parseDaemonGuiReadResult("repo.agenda.read", await bridge.invoke("getAgenda", scope));
    assert.equal(agenda.ok, true);
    const row = agenda.dispatchable.find((candidate) => candidate.taskId === "task-gui-pin");
    assert.notEqual(row, undefined, "the pinned task must appear in the dispatchable group");
    assert.equal(row?.pinned, true, "the agenda projection must carry the same pin");

    const unpinned = parseDaemonGuiActionResponse(
      "repo.task.unpin",
      await bridge.invoke("unpinTask", { ...scope, taskId: "task-gui-pin" }),
    );
    assert.equal(unpinned.ok, true, JSON.stringify(unpinned));
    assert.equal(unpinned.outcome, "applied");
    assert.equal((await taskSnapshot())?.snapshot.task?.pinned ?? false, false, "unpin must clear the ledger field");

    const missing = parseDaemonGuiActionResponse(
      "repo.task.pin",
      await bridge.invoke("pinTask", { ...scope, taskId: "task_does_not_exist" }),
    );
    assert.equal(missing.ok, false, JSON.stringify(missing));
  } finally {
    for (const [name, value] of Object.entries(previous)) restoreEnv(name, value);
    await fixture.stop();
  }
});
