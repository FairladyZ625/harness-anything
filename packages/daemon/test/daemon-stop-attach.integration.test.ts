// harness-test-tier: integration
import { waitForArrival, watchDirectoryArrival } from "../../../tools/fixtures/event-arrival.ts";
import assert from "node:assert/strict";
import { fork } from "node:child_process";
import { once } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { requestDaemonJsonRpcAt } from "../src/client/local-json-rpc-client.ts";
import { localUserDaemonEndpoint } from "../src/client/local-daemon-target.ts";
import { readDaemonPid, readDaemonSingletonLockPid } from "../src/daemon-singleton.ts";
import { readDaemonLifecycleRecords } from "../src/lifecycle-log.ts";
import { rosterRepo } from "./daemon-host-recovery.fixture.ts";
import { registerBootstrappedDaemonRepo } from "./repo-settings.fixture.ts";

test("stop retains ownership until a timed-out attach has really closed", { timeout: 30_000 }, async () => {
  const parent = mkdtempSync(path.join(tmpdir(), "ha-stop-attach-")),
    userRoot = path.join(parent, "user"),
    rootDir = path.join(parent, "repo"),
    daemonId = "stop-attach";
  rosterRepo(rootDir, daemonId);
  registerBootstrappedDaemonRepo({ canonicalRoot: rootDir, repoId: daemonId, userRoot, createConvenienceLinks: false });
  const child = fork(new URL("./fixtures/daemon-stop-attach-child.ts", import.meta.url), [userRoot, daemonId], {
    stdio: ["ignore", "pipe", "pipe", "ipc"],
  });
  let stderr = "";
  child.stderr!.on("data", (chunk) => (stderr += String(chunk)));
  const messages: string[] = [],
    messageWaiters = new Set<() => void>();
  child.on("message", (message) => {
    messages.push(String(message));
    for (const wake of messageWaiters) wake();
  });
  const waitUntil = (predicate: () => boolean | Promise<boolean>): Promise<void> =>
    waitForArrival(
      async () => ((await predicate()) ? true : null),
      (arrive) => {
        messageWaiters.add(arrive);
        const stopDirectory = watchDirectoryArrival(parent)(arrive);
        return () => {
          messageWaiters.delete(arrive);
          stopDirectory();
        };
      },
    );
  const exited = once(child, "exit");
  try {
    await waitUntil(() => messages.includes("ready"));
    const endpoint = localUserDaemonEndpoint(userRoot, daemonId);
    await waitUntil(async () => {
      const status = await requestDaemonJsonRpcAt(endpoint, "daemon.status", {}, 2_000, 2_000);
      return (status.repos as { state: string }[])[0]?.state === "unavailable";
    });
    child.send("stop");
    child.send("probe");
    await waitUntil(() => messages.includes("probed"));
    assert.equal(messages.includes("stopped"), false, `stop returned while raw attach is active: ${stderr}`);
    assert.equal(readDaemonPid(userRoot, daemonId), child.pid);
    assert.equal(readDaemonSingletonLockPid(userRoot, daemonId), child.pid);
    assert.equal(
      readDaemonLifecycleRecords(userRoot, daemonId).some((entry) => entry.event === "process_exit"),
      false,
    );
    child.send("release");
    await waitUntil(() => messages.includes("stopped"));
    const events = readDaemonLifecycleRecords(userRoot, daemonId).map((entry) => entry.event);
    assert.ok(events.indexOf("repo_attach_discarded") < events.indexOf("process_exit"), JSON.stringify(events));
    assert.equal(readDaemonPid(userRoot, daemonId), null);
    child.disconnect();
    assert.deepEqual(await exited, [0, null], stderr);
  } finally {
    if (child.connected) child.send("release");
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    await exited;
    rmSync(parent, { recursive: true, force: true });
  }
});

test(
  "an attach that never closes forces process exit with a recorded deadline reason",
  { timeout: 30_000 },
  async () => {
    const parent = mkdtempSync(path.join(tmpdir(), "ha-stop-deadline-")),
      userRoot = path.join(parent, "user"),
      rootDir = path.join(parent, "repo"),
      daemonId = "stop-deadline";
    rosterRepo(rootDir, daemonId);
    registerBootstrappedDaemonRepo({
      canonicalRoot: rootDir,
      repoId: daemonId,
      userRoot,
      createConvenienceLinks: false,
    });
    const waitUntil = (predicate: () => boolean | Promise<boolean>): Promise<void> =>
      waitForArrival(async () => ((await predicate()) ? true : null), watchDirectoryArrival(parent));
    const child = fork(
      new URL("./fixtures/daemon-stop-attach-child.ts", import.meta.url),
      [userRoot, daemonId, "100"],
      {
        stdio: ["ignore", "ignore", "pipe", "ipc"],
      },
    );
    const exited = once(child, "exit");
    try {
      await once(child, "message");
      const endpoint = localUserDaemonEndpoint(userRoot, daemonId);
      await waitUntil(async () => {
        const status = await requestDaemonJsonRpcAt(endpoint, "daemon.status", {}, 2_000, 2_000);
        return (status.repos as { state: string }[])[0]?.state === "unavailable";
      });
      child.send("stop");
      assert.deepEqual(await exited, [1, null]);
      const exit = readDaemonLifecycleRecords(userRoot, daemonId).find(
        (entry) => entry.event === "process_exit" && entry.outcome === "shutdown_deadline_exceeded",
      );
      assert.equal(exit?.reason, "stop_requested");
      assert.equal(exit?.durationMs, 100);
      assert.match(exit?.error ?? "", /attachingRepositories|activeResources/u);
    } finally {
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
      await exited;
      rmSync(parent, { recursive: true, force: true });
    }
  },
);
