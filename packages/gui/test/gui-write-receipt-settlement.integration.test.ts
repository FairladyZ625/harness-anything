// harness-test-tier: integration
import assert from "node:assert/strict";
import test from "node:test";
import { createLocalGuiServiceBridge } from "../src/main/local-composition-root.ts";
import { harnessClient } from "../src/renderer/api-client.ts";
import { settleTaskReceipt } from "../src/renderer/task-actions.ts";
import { startGuiResidentDaemonFixture } from "../test-support/resident-daemon.mjs";

type Receipt = Record<string, unknown> & {
  readonly opId: string;
  readonly outcome: string;
  readonly status?: string;
  readonly code?: string;
};

/**
 * renderer 的 `window.harness` 只是把每个 bridge 方法转给 main 进程的同名调用,
 * 这里用真 daemon 上的 GUI service bridge 顶上去,于是 `harnessClient` 的写路
 * 是真的 renderer → main → daemon,而不是 mock。每个经过的 bridge 方法都记下来。
 */
function installRendererBridge(
  bridge: { invoke: (method: string, payload: unknown) => Promise<unknown> },
  invoked: string[],
): () => void {
  const previous = (globalThis as { window?: unknown }).window;
  const harness = new Proxy(
    {},
    {
      get: (_target, method: string) => (payload: unknown) => {
        invoked.push(method);
        return bridge.invoke(method, payload);
      },
    },
  );
  Object.defineProperty(globalThis, "window", { value: { harness }, configurable: true, writable: true });
  return () => {
    Object.defineProperty(globalThis, "window", { value: previous, configurable: true, writable: true });
  };
}

test("GUI task writes settle from their own durable receipt without a follow-up receipt read", async () => {
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
  const invoked: string[] = [],
    bridge = createLocalGuiServiceBridge(fixture.rootDir),
    restoreWindow = installRendererBridge(bridge, invoked),
    scope = { repoId: fixture.repoId },
    taskId = "task-gui-receipt";
  try {
    // The write receipt already carries durable acceptance and projection visibility; Git and
    // worktree follower progress is not awaited, so the receipt is applied as returned.
    for (const written of [
      (await harnessClient.pinTask({ ...scope, taskId })) as unknown as Receipt,
      (await harnessClient.unpinTask({ ...scope, taskId })) as unknown as Receipt,
    ]) {
      assert.equal(written.status, "accepted_durable", JSON.stringify(written));
      assert.equal("wait" in written, false, JSON.stringify(written));
      assert.equal(settleTaskReceipt(written as never).state, "applied", JSON.stringify(written));
    }
    assert.deepEqual(invoked, ["pinTask", "unpinTask"]);

    // An operation that never published stays a rejected read; it is never reported as applied.
    const unknown = (await harnessClient.showReceipt({ ...scope, opId: "op-never-published" })) as unknown as Receipt;
    assert.equal(unknown.outcome, "op_rejected", JSON.stringify(unknown));
    assert.equal(unknown.code, "operation_not_published", JSON.stringify(unknown));
    assert.equal(settleTaskReceipt(unknown as never).state, "op_rejected");
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
