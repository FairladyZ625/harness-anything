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
 * GUI task pin/unpin 与顶层 Entity Pin 共用 durable write path，payload 仍保持闭集。
 */
test("GUI task pin ingress maps onto the Entity Pin action", () => {
  const pin = parseDaemonRpcParams("repo.task.pin", {
    repo: { repoId: "alpha" },
    payload: { taskId: "task_current" },
  });
  assert.equal(pin.ok, true);
  assert.deepEqual(actionForDaemonMethod("repo.task.pin", { taskId: "task_current" }), {
    kind: "entity-pin",
    taskId: "task_current",
  });
  assert.deepEqual(actionForDaemonMethod("repo.task.unpin", { taskId: "task_current" }), {
    kind: "entity-unpin",
    taskId: "task_current",
  });
  assert.equal(commandClassForAction("entity-pin"), "repo-write");
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
