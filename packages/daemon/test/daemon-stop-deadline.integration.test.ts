// harness-test-tier: integration
import assert from "node:assert/strict";
import { fork } from "node:child_process";
import { once } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { requestDaemonJsonRpcAt } from "../src/client/local-json-rpc-client.ts";
import { localUserDaemonEndpoint } from "../src/client/local-daemon-target.ts";
import { readDaemonLifecycleRecords } from "../src/lifecycle-log.ts";
import { readDaemonSingletonLockPid } from "../src/daemon-singleton.ts";
import { rosterRepo } from "./daemon-host-recovery.fixture.ts";
import { registerBootstrappedDaemonRepo } from "./repo-settings.fixture.ts";

async function waitUntil(predicate: () => boolean | Promise<boolean>): Promise<void> {
  const deadline = Date.now() + 15_000;
  while (!(await predicate())) {
    assert.ok(Date.now() < deadline, "fixture state did not arrive");
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
}

test("a cell that never closes forces process exit with a recorded deadline reason", { timeout: 30_000 }, async () => {
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
  const child = fork(
    new URL("./fixtures/daemon-stop-deadline-child.ts", import.meta.url),
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
      return (status.repos as { state: string }[])[0]?.state === "attached";
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
});

for (const { buildSuperseded, rejectDrain } of [
  { buildSuperseded: false, rejectDrain: true },
  { buildSuperseded: true, rejectDrain: true },
  { buildSuperseded: true, rejectDrain: false },
]) {
  test(`${buildSuperseded ? "supersession" : "operator stop"} deadline with late ${rejectDrain ? "failed" : "successful"} drain recovers once before exit`, async (t) => {
    const parent = mkdtempSync(path.join(tmpdir(), "ha-deadline-recovery-")),
      userRoot = path.join(parent, "user"),
      rootDir = path.join(parent, "repo"),
      daemonId = "deadline-recovery";
    rosterRepo(rootDir, daemonId);
    registerBootstrappedDaemonRepo({
      canonicalRoot: rootDir,
      repoId: daemonId,
      userRoot,
      createConvenienceLinks: false,
    });
    const closing = Promise.withResolvers<void>(),
      closeGate = Promise.withResolvers<void>(),
      recoveryGate = Promise.withResolvers<void>(),
      forcedExit = Promise.withResolvers<void>();
    let recoveryCalls = 0,
      exitCalls = 0,
      drifted = false,
      normalHandoffCalls = 0;
    const { startDaemon } = await import("../src/runtime.ts"),
      { openBootstrappedRepoCell } = await import("./repo-settings.fixture.ts");
    const daemon = await startDaemon({
      userRoot,
      daemonId,
      buildObserver: {
        status: () => ({
          commit: null,
          entry: "dist",
          loadedBuildId: "build-a",
          diskBuildId: drifted ? "build-b" : "build-a",
          drifted,
        }),
      },
      retainPidUntilExit: true,
      onSupersededExit: () => {
        normalHandoffCalls += 1;
      },
      onSupersededFailure: async () => {
        recoveryCalls += 1;
        await recoveryGate.promise;
      },
      shutdownDeadlineExceeded: () => {
        exitCalls += 1;
        forcedExit.resolve();
      },
      openCell: async (input) => {
        const cell = await openBootstrappedRepoCell(input);
        return {
          ...cell,
          close: async () => {
            await cell.close();
            closing.resolve();
            await closeGate.promise;
            if (rejectDrain) throw new Error("injected late drain failure");
          },
        };
      },
    });
    assert.ok("stop" in daemon);
    try {
      await waitUntil(async () => {
        const status = await requestDaemonJsonRpcAt(daemon.endpoint, "daemon.status", {}, 2_000, 2_000);
        return (status.repos as { state: string }[])[0]?.state === "attached";
      });
      t.mock.timers.enable({ apis: ["setTimeout"] });
      if (buildSuperseded) {
        drifted = true;
        await requestDaemonJsonRpcAt(daemon.endpoint, "daemon.status", {}, 2_000, 2_000, undefined, true);
        await closing.promise;
      }
      const stop = daemon.stop(),
        stopped = rejectDrain ? assert.rejects(stop, /injected late drain failure/u) : stop;
      await closing.promise;
      t.mock.timers.tick(30_000);
      await new Promise<void>((resolve) => setImmediate(resolve));
      assert.equal(recoveryCalls, buildSuperseded ? 1 : 0, "only supersession deadlines must recover");
      assert.equal(exitCalls, buildSuperseded ? 0 : 1, "supersession must prepare its successor before forced exit");
      closeGate.resolve();
      await new Promise<void>((resolve) => setImmediate(resolve));
      assert.equal(recoveryCalls, buildSuperseded ? 1 : 0, "a late drain rejection must share the pending recovery");
      recoveryGate.resolve();
      await forcedExit.promise;
      await stopped;
      assert.equal(exitCalls, 1);
      assert.equal(normalHandoffCalls, 0, "a deadline must not also take the normal handoff");
      const exits = readDaemonLifecycleRecords(userRoot, daemonId).filter((entry) => entry.event === "process_exit");
      assert.equal(exits.length, 1, "late teardown must not overwrite the deadline's terminal diagnosis");
      assert.equal(exits[0]?.outcome, "shutdown_deadline_exceeded");
      assert.equal(
        readDaemonSingletonLockPid(userRoot, daemonId),
        buildSuperseded ? process.pid : null,
        "a timed out resident must keep its writer claim until actual process exit",
      );
    } finally {
      closeGate.resolve();
      recoveryGate.resolve();
      await daemon.stop().catch((error: unknown) => {
        assert.match(String(error), /injected late drain failure/u);
      });
      rmSync(parent, { recursive: true, force: true });
    }
  });
}
