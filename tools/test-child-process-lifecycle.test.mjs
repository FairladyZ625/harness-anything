// harness-test-tier: fast
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import {
  terminateChildAndWait,
  waitForChildExit
} from "./test-child-process-lifecycle.mjs";

test("child termination observes a synchronous exit emitted by the native action", async () => {
  const child = fakeChild();
  const exit = await terminateChildAndWait(child, (target) => {
    target.exitCode = 1;
    target.emit("exit", 1, null);
  }, { timeoutMs: 100, label: "synchronous child" });

  assert.deepEqual(exit, { code: 1, signal: null });
  assert.equal(child.listenerCount("exit"), 0);
  assert.equal(child.listenerCount("error"), 0);
});

test("child exit waiting is bounded and removes its observers", async () => {
  const child = fakeChild();
  await assert.rejects(
    waitForChildExit(child, { timeoutMs: 10, label: "stalled child" }),
    /stalled child did not exit within 10ms/u
  );
  assert.equal(child.listenerCount("exit"), 0);
  assert.equal(child.listenerCount("error"), 0);
});

function fakeChild() {
  return Object.assign(new EventEmitter(), {
    pid: 48002,
    exitCode: null,
    signalCode: null,
    kill: () => true
  });
}
