// harness-test-tier: integration
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { createDaemonRuntime } from "../../src/runtime/repo-runtime.ts";
import { docWrite, withTempStoreAsync } from "../../../kernel/test/store/helpers.ts";
import { daemonAttribution, initAuthoredGit } from "./helpers/daemon-runtime.ts";

const testAttribution = daemonAttribution("person_test", "test", "credential-test");

test("projection subscribers cannot change write outcomes and do not survive daemon restart", async () => {
  await withTempStoreAsync(async (rootDir) => {
    initAuthoredGit(rootDir);
    const runtime = createDaemonRuntime({
      rootDir,
      materializerPollMs: false,
      interactiveMicroBatchMs: 0
    });
    await runtime.start();

    const withoutSubscriber = await runtime.enqueueInteractiveWrite({
      commandId: "cmd-without-projection-subscriber",
      attribution: testAttribution,
      ops: [docWrite("op-without-projection-subscriber", "task-no-subscriber", "note.md", "no subscriber")]
    });
    let staleSubscriberCalls = 0;
    runtime.subscribeProjectionChanges(() => {
      staleSubscriberCalls += 1;
      throw new Error("disconnected projection subscriber");
    });
    const withDisconnectedSubscriber = await runtime.enqueueInteractiveWrite({
      commandId: "cmd-with-disconnected-projection-subscriber",
      attribution: testAttribution,
      ops: [docWrite("op-with-disconnected-projection-subscriber", "task-disconnected-subscriber", "note.md", "disconnected subscriber")]
    });

    assert.equal(withoutSubscriber.durable, true);
    assert.equal(withDisconnectedSubscriber.durable, true);
    assert.equal(staleSubscriberCalls, 1);
    assert.equal(readFileSync(path.join(rootDir, "harness/tasks/task-no-subscriber/note.md"), "utf8"), "no subscriber");
    assert.equal(readFileSync(path.join(rootDir, "harness/tasks/task-disconnected-subscriber/note.md"), "utf8"), "disconnected subscriber");
    await runtime.stop();

    const restarted = createDaemonRuntime({
      rootDir,
      materializerPollMs: false,
      interactiveMicroBatchMs: 0
    });
    await restarted.start();
    let restartedSubscriberCalls = 0;
    restarted.subscribeProjectionChanges(() => {
      restartedSubscriberCalls += 1;
    });
    const afterRestart = await restarted.enqueueInteractiveWrite({
      commandId: "cmd-after-projection-subscriber-restart",
      attribution: testAttribution,
      ops: [docWrite("op-after-projection-subscriber-restart", "task-after-restart", "note.md", "after restart")]
    });

    assert.equal(afterRestart.durable, true);
    assert.equal(staleSubscriberCalls, 1);
    assert.equal(restartedSubscriberCalls, 1);
    await restarted.stop();
  });
});
