// harness-test-tier: integration
import assert from "node:assert/strict";
import test from "node:test";
import { parseDaemonGuiActionResponse } from "../../daemon/src/protocol/gui-result-validation.ts";
import { createLocalGuiServiceBridge } from "../src/main/local-composition-root.ts";
import { harnessClient } from "../src/renderer/api-client.ts";
import { settleTaskReceipt } from "../src/renderer/task-actions.ts";
import { startGuiResidentDaemonFixture } from "../test-support/resident-daemon.mjs";

type Receipt = Record<string, unknown> & {
  readonly opId: string;
  readonly outcome: string;
  readonly status?: string;
  readonly proof?: { readonly canonicalVisible?: boolean; readonly worktreeVisible?: boolean | null };
  readonly worktree?: { readonly state?: string };
  readonly wait?: { readonly state?: string; readonly unsatisfied?: readonly string[] };
};

/**
 * renderer 的 `window.harness` 只是把每个 bridge 方法转给 main 进程的同名调用,
 * 这里用真 daemon 上的 GUI service bridge 顶上去,于是 `harnessClient` 的写路
 * 是真的 renderer → main → daemon,而不是 mock。
 */
function installRendererBridge(bridge: { invoke: (method: string, payload: unknown) => Promise<unknown> }): () => void {
  const previous = (globalThis as { window?: unknown }).window;
  const harness = new Proxy(
    {},
    { get: (_target, method: string) => (payload: unknown) => bridge.invoke(method, payload) },
  );
  Object.defineProperty(globalThis, "window", { value: { harness }, configurable: true, writable: true });
  return () => {
    Object.defineProperty(globalThis, "window", { value: previous, configurable: true, writable: true });
  };
}

test("GUI task writes settle through the daemon receipt wait instead of stalling on canonical_not_visible", async () => {
  const fixture = await startGuiResidentDaemonFixture({
    daemonId: "gui-receipt-settlement",
    repoId: "gui-receipt",
    task: { taskId: "task-gui-receipt", title: "Receipt settlement task" },
  });
  const previous = {
    userRoot: process.env.HARNESS_DAEMON_USER_ROOT,
    daemonId: process.env.HARNESS_DAEMON_ID,
    repoId: process.env.HARNESS_DAEMON_REPO_ID,
  };
  Object.assign(process.env, fixture.env);
  const bridge = createLocalGuiServiceBridge(fixture.rootDir),
    restoreWindow = installRendererBridge(bridge),
    scope = { repoId: fixture.repoId },
    taskId = "task-gui-receipt";
  try {
    // 复现:写回执本身是 follower 发布之前那一瞬的快照——canonical 已经接受,
    // 但 worktree 还没追平,renderer 的落定判据因此永远不成立。
    const written = parseDaemonGuiActionResponse(
      "repo.task.pin",
      await bridge.invoke("pinTask", { ...scope, taskId }),
    ) as unknown as Receipt;
    assert.equal(written.status, "accepted_durable", JSON.stringify(written));
    assert.equal(written.worktree?.state, "pending", JSON.stringify(written));
    assert.notEqual(written.proof?.worktreeVisible, true, JSON.stringify(written));
    assert.equal(
      (await settleTaskReceipt(written as never, ({ opId }) => harnessClient.showReceipt({ ...scope, opId }))).state,
      "pending",
      "an unsettled write receipt must not be reported as applied",
    );

    // 修复:renderer 客户端把同一条 daemon 落定协议用上,写回执交回来时已经可见。
    const settled = (await harnessClient.unpinTask({ ...scope, taskId })) as unknown as Receipt;
    assert.equal(settled.status, "accepted_durable", JSON.stringify(settled));
    assert.equal(settled.wait?.state, "satisfied", JSON.stringify(settled));
    assert.equal(settled.outcome, "applied", JSON.stringify(settled));
    assert.equal(settled.proof?.canonicalVisible, true, JSON.stringify(settled));
    assert.equal(settled.proof?.worktreeVisible, true, JSON.stringify(settled));
    assert.deepEqual(
      await settleTaskReceipt(settled as never, ({ opId }) => harnessClient.showReceipt({ ...scope, opId })),
      {
        state: "applied",
        opId: settled.opId,
        revision: settled.revision,
        receipt: settled,
      },
    );

    // 可区分回归:真正未知的操作不会被落定等待说成成功,它仍然是被拒的读。
    const unknown = (await harnessClient.showReceipt({
      ...scope,
      opId: "op-never-published",
      waitFor: ["projection_visible", "git_verified", "worktree_visible"],
      timeoutMs: 250,
    })) as unknown as Receipt;
    assert.equal(unknown.outcome, "op_rejected", JSON.stringify(unknown));
    assert.equal(unknown.code, "operation_not_published", JSON.stringify(unknown));
    assert.equal(
      (await settleTaskReceipt(unknown as never, ({ opId }) => harnessClient.showReceipt({ ...scope, opId }))).state,
      "op_rejected",
    );

    // 落定谓词是 daemon 校验的:renderer 不能拿它当自由文本。
    const unsupported = (await harnessClient.showReceipt({
      ...scope,
      opId: settled.opId,
      waitFor: ["whatever_i_want"],
    })) as unknown as Receipt;
    assert.equal(unsupported.ok, false, JSON.stringify(unsupported));
    assert.equal(unsupported.code, "unsupported_wait_condition", JSON.stringify(unsupported));
  } finally {
    restoreWindow();
    for (const [key, value] of Object.entries({
      HARNESS_DAEMON_USER_ROOT: previous.userRoot,
      HARNESS_DAEMON_ID: previous.daemonId,
      HARNESS_DAEMON_REPO_ID: previous.repoId,
    }))
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    await fixture.stop();
  }
});
