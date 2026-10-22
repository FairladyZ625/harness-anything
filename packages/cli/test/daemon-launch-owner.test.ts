// harness-test-tier: fast
import assert from "node:assert/strict";
import test from "node:test";
import { cliDaemonServeLaunch, daemonLaunchOwnerPid } from "../src/daemon/client.ts";

// A daemon started by a test is detached, so it outlives the command that started it. The
// runner's preload names each test file process as the owner; a test file run directly with
// `node --test <path>` has no preload, and its daemon then outlives the file. The launch seam
// itself names the test file process, which is the CLI's parent inside a `node --test` child.
function withoutOwner<T>(context: string | undefined, run: () => T): T {
  const previous = {
    owner: process.env.HARNESS_DAEMON_OWNER_PID,
    context: process.env.NODE_TEST_CONTEXT,
  };
  try {
    delete process.env.HARNESS_DAEMON_OWNER_PID;
    if (context === undefined) delete process.env.NODE_TEST_CONTEXT;
    else process.env.NODE_TEST_CONTEXT = context;
    return run();
  } finally {
    for (const [key, value] of [
      ["HARNESS_DAEMON_OWNER_PID", previous.owner],
      ["NODE_TEST_CONTEXT", previous.context],
    ] as const) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

test("a launch outside a test run names no owner, so the resident daemon's lifetime is unchanged", () => {
  withoutOwner(undefined, () => {
    assert.equal(daemonLaunchOwnerPid(process.env, 4242), undefined);
    assert.equal(cliDaemonServeLaunch("/daemon-user", "worker").env.HARNESS_DAEMON_OWNER_PID, undefined);
  });
});

test("a test-file process names itself as the owner instead of the runner that started it", () => {
  withoutOwner("child-v8", () => {
    const testFilePid = process.ppid;
    assert.notEqual(testFilePid, process.pid, "the CLI runs in a child of the test-file process");
    assert.equal(daemonLaunchOwnerPid(process.env, testFilePid), String(testFilePid));
    assert.equal(cliDaemonServeLaunch("/daemon-user", "worker").env.HARNESS_DAEMON_OWNER_PID, String(testFilePid));
  });
});

test("an owner the runner already named wins over the inferred one", () => {
  const previous = process.env.HARNESS_DAEMON_OWNER_PID;
  try {
    process.env.HARNESS_DAEMON_OWNER_PID = "777";
    assert.equal(daemonLaunchOwnerPid({ ...process.env, NODE_TEST_CONTEXT: "child-v8" }, 4242), "777");
  } finally {
    if (previous === undefined) delete process.env.HARNESS_DAEMON_OWNER_PID;
    else process.env.HARNESS_DAEMON_OWNER_PID = previous;
  }
});
