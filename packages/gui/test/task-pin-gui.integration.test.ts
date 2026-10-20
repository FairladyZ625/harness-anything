// harness-test-tier: integration
import assert from "node:assert/strict";
import test from "node:test";
import { parseDaemonGuiActionResponse, parseDaemonGuiReadResult } from "@harness-anything/daemon/client";
import { requestDaemonJsonRpcAt } from "@harness-anything/daemon/internal/client/local-json-rpc-client";
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

/**
 * 非任务实体的解 pin 端到端(task_9ba495de):置备与置顶走 daemon RPC(CLI `ha pin` 同一条
 * repo.task.run/entity-pin),解 pin 走 GUI 桥的 unpinEntity;读回以 repo.agenda.read 的
 * pinnedEntities 两面前后对照。GUI 不补「置顶」入射,按任务书只开取消置顶。
 */
test("GUI entity unpin clears a CLI-pinned decision through the resident daemon write path", async () => {
  const fixture = await startGuiResidentDaemonFixture({
    daemonId: "gui-entity-unpin-integration",
    repoId: "gui-entity-unpin",
  });
  const previous = {
    userRoot: process.env.HARNESS_DAEMON_USER_ROOT,
    daemonId: process.env.HARNESS_DAEMON_ID,
    repoId: process.env.HARNESS_DAEMON_REPO_ID,
    endpoint: process.env.HARNESS_DAEMON_ENDPOINT,
  };
  delete process.env.HARNESS_DAEMON_ENDPOINT;
  Object.assign(process.env, fixture.env);
  try {
    const bridge = createLocalGuiServiceBridge(fixture.rootDir),
      scope = { repoId: fixture.repoId },
      pinnedRefs = async () =>
        parseDaemonGuiReadResult("repo.agenda.read", await bridge.invoke("getAgenda", scope)).pinnedEntities.map(
          ({ ref }) => ref,
        ),
      proposed = (await requestDaemonJsonRpcAt(
        fixture.endpoint,
        "repo.decision.propose",
        {
          repo: { repoId: fixture.repoId },
          payload: {
            title: "Unpin a decision from the GUI",
            question: "Can the overview unpin a pinned decision?",
            riskTier: "low",
            urgency: "low",
            vertical: "default",
            preset: "default",
            appliesTo: { modules: ["gui"], productLines: [] },
            decisionClass: "ordinary",
            chosen: [{ id: "CH1", text: "Unpin it" }],
            rejected: [{ id: "RJ1", text: "Keep it pinned", whyNot: "No action from the GUI" }],
            body: "# Unpin decision\n\n## 背景\n\nPinned decisions need a GUI unpin.\n\n## 权衡\n\nReuse the entity-unpin path.\n\n## 结论\n\nUnpin through the bridge.\n",
            claims: [],
            fulfillments: [],
          },
        },
        2_000,
      )) as { readonly ok: boolean; readonly evidence?: string },
      decisionId = String((JSON.parse(String(proposed.evidence)) as { decisionId: string }).decisionId),
      entityRef = `decision/${decisionId}`,
      pinned = await requestDaemonJsonRpcAt(
        fixture.endpoint,
        "repo.task.run",
        { repo: { repoId: fixture.repoId }, payload: { action: { kind: "entity-pin", entityRef } } },
        2_000,
      );
    assert.equal(proposed.ok, true, JSON.stringify(proposed));
    assert.equal((pinned as { readonly outcome?: string }).outcome, "applied", JSON.stringify(pinned));
    assert.equal((await pinnedRefs()).includes(entityRef), true, "the CLI pin must be visible in the agenda");

    const unpinned = parseDaemonGuiActionResponse(
      "repo.entity.unpin",
      await bridge.invoke("unpinEntity", { ...scope, entityRef }),
    );
    assert.equal(unpinned.ok, true, JSON.stringify(unpinned));
    assert.equal(unpinned.outcome, "applied");
    assert.equal((await pinnedRefs()).includes(entityRef), false, "the GUI unpin must clear the agenda pin");

    const missing = parseDaemonGuiActionResponse(
      "repo.entity.unpin",
      await bridge.invoke("unpinEntity", { ...scope, entityRef: "decision/dec_does_not_exist" }),
    );
    assert.equal(missing.ok, false, JSON.stringify(missing));
  } finally {
    for (const [name, value] of Object.entries(previous)) restoreEnv(name, value);
    await fixture.stop();
  }
});
