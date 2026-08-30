// harness-test-tier: fast
import assert from "node:assert/strict";
import test from "node:test";
import {
  actionForDaemonMethod,
  commandClassForAction,
  daemonGuiActionMethods,
  parseDaemonRpcParams,
} from "../src/protocol/daemon-protocol.contract.ts";

/**
 * GUI pin/unpin 是既有 task amend 写面的具名入口,不是第二条写路:协议层必须把它
 * 映射成与 `ha task pin` 完全相同的 pinned-only `task-amend` 动作,并且 payload 闭集
 * 不允许 renderer 夹带其它 amend 字段。
 */
test("GUI pin ingress maps onto the pinned-only task-amend action", () => {
  const pin = parseDaemonRpcParams("repo.task.pin", {
    repo: { repoId: "alpha" },
    payload: { taskId: "task_current" },
  });
  assert.equal(pin.ok, true);
  assert.deepEqual(actionForDaemonMethod("repo.task.pin", { taskId: "task_current" }), {
    patches: [{ field: "pinned", value: "true" }],
    kind: "task-amend",
    taskId: "task_current",
  });
  assert.deepEqual(actionForDaemonMethod("repo.task.unpin", { taskId: "task_current" }), {
    patches: [{ field: "pinned", value: "false" }],
    kind: "task-amend",
    taskId: "task_current",
  });
  assert.equal(commandClassForAction("task-amend"), "repo-write");
});

test("GUI pin ingress stays closed to the renderer", () => {
  // 声明的 payload 只有 taskId:任何其它 amend 字段在 RPC 校验层就被拒。
  for (const method of ["repo.task.pin", "repo.task.unpin"]) {
    const extra = parseDaemonRpcParams(method, {
      repo: { repoId: "alpha" },
      payload: { taskId: "task_current", patches: [{ field: "title", value: "smuggled" }] },
    });
    assert.equal(extra.ok, false, `${method} must reject an amend patch`);
    assert.equal(
      parseDaemonRpcParams(method, { repo: { repoId: "alpha" }, payload: { taskId: "" } }).ok,
      false,
      `${method} must reject an empty taskId`,
    );
  }
  assert.equal(
    daemonGuiActionMethods.some(({ method }) => method === "repo.task.run"),
    false,
    "the generic task action RPC must stay off the GUI bridge",
  );
  for (const guiBridgeMethod of ["pinTask", "unpinTask"])
    assert.equal(
      daemonGuiActionMethods.some((entry) => entry.guiBridgeMethod === guiBridgeMethod),
      true,
      `${guiBridgeMethod} must be declared once on the GUI bridge`,
    );
});
