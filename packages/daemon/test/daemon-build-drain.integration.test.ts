// harness-test-tier: integration
import assert from "node:assert/strict";
import { withPolicyGroup, signInPolicyTestUser } from "./keycloak-policy.fixtures.ts";
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import net from "node:net";
import { JsonRpcLineClient } from "../src/client/local-json-rpc-client.ts";
import { openRemoteProxyManager } from "../src/remote-proxy.ts";
import { currentDaemonProtocolVersion } from "../src/protocol/version.ts";
import test from "node:test";
import {
  consumeKnownError,
  registerDaemonRepo,
  makeTaskEventReader,
  makeTaskProjection,
  type AgentDefinitionSnapshot,
} from "@harness-anything/kernel";
import { ensureLocalDaemonRunning, type DaemonLaunchSpec } from "../src/client/daemon-autostart.ts";
import { localUserDaemonEndpoint } from "../src/client/local-daemon-target.ts";
import { requestDaemonJsonRpcAt } from "../src/client/local-json-rpc-client.ts";
import { observeDaemonBuild } from "../src/build-identity.ts";
import { readDaemonLifecycleRecords } from "../src/lifecycle-log.ts";
import { daemonSingletonLockPath } from "../src/daemon-singleton.ts";
import { daemonPidPath, readDaemonPid, startDaemon, type RunningDaemon } from "../src/runtime.ts";
import { openBootstrappedRepoCell, registerBootstrappedDaemonRepo } from "./repo-settings.fixture.ts";
import { writeProviderExecutable } from "./fixtures/runtime-stub.ts";

for (const phase of ["attached", "attaching", "abandoned"] as const) {
  test(`supersession keeps the hello exchange admitted until its ${phase} client requests or disconnects`, async () => {
    const parent = mkdtempSync(path.join(tmpdir(), "ha-daemon-hello-drain-")),
      rootDir = path.join(parent, "repo"),
      userRoot = path.join(parent, "user"),
      repoId = `hello-drain-${phase}`,
      runtimeFile = builtRuntime(path.join(parent, "runtime"), "build-a"),
      buildIdPath = path.join(parent, "runtime/packages/cli/dist/build-id.txt"),
      cellOpened = deferred<void>(),
      attachmentGate = deferred<void>(),
      superseded = deferred<void>();
    let daemon: RunningDaemon | undefined,
      client: JsonRpcLineClient | undefined,
      cellClosing = false,
      notifyStatus: (() => void) | undefined,
      queueIsEmpty: (() => boolean) | undefined;
    initializeRepo(rootDir, repoId);
    signInPolicyTestUser(userRoot, "writer", [repoId], "admin");
    registerBootstrappedDaemonRepo({ canonicalRoot: rootDir, repoId, userRoot, createConvenienceLinks: false });
    try {
      daemon = runningDaemon(
        await startDaemon({
          daemonId: repoId,
          userRoot,
          runtimeFile,
          onSupersededExit: () => superseded.resolve(),
          openCell: async (input) => {
            const cell = await openBootstrappedRepoCell(input);
            // A real status update can arm drain independently of the request that observed drift.
            notifyStatus = () => input.onStatus?.(cell.status());
            queueIsEmpty = () => cell.status().queueDepth === 0;
            cellOpened.resolve();
            if (phase === "attaching") await attachmentGate.promise;
            return {
              ...cell,
              close: async () => {
                cellClosing = true;
                await cell.close();
              },
            };
          },
        }),
      );
      await cellOpened.promise;
      await waitUntil(() => queueIsEmpty!());
      if (phase !== "attaching")
        await waitUntil(async () => {
          const status = await requestDaemonJsonRpcAt(daemon!.endpoint, "daemon.status", {}, 2_000, 2_000);
          return (status.repos as { readonly state: string }[])[0]?.state === "attached";
        });
      writeFileSync(buildIdPath, "build-b\n", "utf8");
      const socket = net.createConnection(daemon.endpoint);
      client = new JsonRpcLineClient(socket, socket);
      const hello = await client.request(
        "protocol.hello",
        {
          protocolVersion: currentDaemonProtocolVersion,
          reportStaleBuild: true,
        },
        2_000,
      );
      assert.equal(hello.ok, true);
      assert.equal((hello.warning as Record<string, unknown>).code, "daemon_build_stale");
      notifyStatus!();
      // A separate client's completed read also checks drain, independently of this hello.
      await requestDaemonJsonRpcAt(daemon.endpoint, "daemon.status", {}, 2_000, 2_000);
      await eventLoopTurn();
      await eventLoopTurn();
      assert.equal(cellClosing, false, "a status-triggered drain must not strand the hello client's next frame");
      assert.equal(readDaemonPid(userRoot, repoId), process.pid);
      if (phase === "abandoned") {
        client.close();
        client = undefined;
        await superseded.promise;
      } else {
        const taskId = `task-${repoId}`,
          receiptPromise = client.request(
            "repo.task.create",
            {
              repo: { repoId },
              payload: { taskId, title: "Admitted hello exchange" },
            },
            5_000,
          );
        attachmentGate.resolve();
        const receipt = await receiptPromise;
        assert.equal(receipt.outcome, "applied", JSON.stringify(receipt));
        client.close();
        client = undefined;
        await superseded.promise;
        const created = makeTaskEventReader({ repoId, rootDir })
          .read()
          .events.filter((event) => event.type === "task_bootstrapped" && event.taskId === taskId);
        assert.equal(created.length, 1, "the accepted write remains canonical after complete teardown");
      }
      assert.equal(readDaemonPid(userRoot, repoId), null);
    } finally {
      attachmentGate.resolve();
      client?.close();
      await daemon?.stop();
      rmSync(parent, { recursive: true, force: true });
    }
  });
}

for (const detached of [false, true]) {
  test(`a fresh stream-only proxy permits supersession with its stream ${detached ? "detached" : "attached"}`, async () => {
    const parent = mkdtempSync(path.join(tmpdir(), "ha-proxy-stream-drain-")),
      rootDir = path.join(parent, "repo"),
      userRoot = path.join(parent, "user"),
      proxyRoot = path.join(parent, "proxy"),
      repoId = "proxy-stream-drain",
      runtimeFile = builtRuntime(path.join(parent, "runtime"), "build-a"),
      buildIdPath = path.join(parent, "runtime/packages/cli/dist/build-id.txt"),
      proxy = openRemoteProxyManager(proxyRoot);
    let daemon: RunningDaemon | undefined;
    initializeRepo(rootDir, repoId);
    signInPolicyTestUser(userRoot, "writer", [repoId], "admin");
    registerBootstrappedDaemonRepo({ canonicalRoot: rootDir, repoId, userRoot, createConvenienceLinks: false });
    try {
      daemon = runningDaemon(
        await startDaemon({ daemonId: repoId, userRoot, runtimeFile, openCell: openBootstrappedRepoCell }),
      );
      await waitUntil(async () => {
        const status = await requestDaemonJsonRpcAt(daemon!.endpoint, "daemon.status", {}, 2_000, 2_000);
        return (status.repos as { readonly state: string }[])[0]?.state === "attached";
      });
      const terminal = await requestDaemonJsonRpcAt(daemon.endpoint, "repo.terminal.spawn", {
        repo: { repoId },
        payload: {
          idempotencyKey: "stream-drain",
          backend: "direct-pty",
          name: "Stream drain",
          cwd: { scope: "repo-root" },
          shellProfileId: "sh",
        },
      });
      assert.equal(terminal.outcome, "applied", JSON.stringify(terminal));
      registerDaemonRepo({
        userRoot: proxyRoot,
        repoId,
        mode: "remote-proxy",
        endpoint: daemon.endpoint,
        createConvenienceLinks: false,
      });
      // This manager has never issued a request: its first and only operation is a real attach.
      const stream = await proxy.stream(repoId, "repo.terminal.attach", {
        sessionId: String(terminal.sessionId),
        afterSeq: 0,
      });
      assert.equal(stream.initial.ok, true, JSON.stringify(stream.initial));
      if (detached) stream.detach();
      writeFileSync(buildIdPath, "build-b\n", "utf8");
      const taskId = "task-stream-drain",
        receipt = await requestDaemonJsonRpcAt(
          daemon.endpoint,
          "repo.task.create",
          {
            repo: { repoId },
            payload: { taskId, title: "Retained across stream-only supersession" },
          },
          2_000,
          5_000,
          undefined,
          true,
        );
      assert.equal(receipt.outcome, "applied", JSON.stringify(receipt));
      // Keep the manager alive throughout: closing it would conceal the cached hello leak.
      await waitUntil(() => readDaemonPid(userRoot, repoId) === null);
      assert.equal(
        readDaemonLifecycleRecords(userRoot, repoId).some(
          (record) => record.event === "process_exit" && record.outcome === "build_superseded",
        ),
        true,
      );
      const created = makeTaskEventReader({ repoId, rootDir })
        .read()
        .events.filter((event) => event.type === "task_bootstrapped" && event.taskId === taskId);
      assert.equal(created.length, 1, "the accepted write remains canonical after supersession teardown");
    } finally {
      proxy.close();
      await daemon?.stop();
      rmSync(parent, { recursive: true, force: true });
    }
  });
}

test("the daemon binds and serves status and queued commands before repository attachment settles", async () => {
  const parent = mkdtempSync(path.join(tmpdir(), "ha-daemon-bind-before-attach-")),
    rootDir = path.join(parent, "repo"),
    userRoot = path.join(parent, "user"),
    repoId = "bind-before-attach",
    attachmentGate = deferred<void>(),
    attachmentStarted = deferred<void>();
  let daemon: RunningDaemon | undefined,
    attachmentReleased = false;
  initializeRepo(rootDir, repoId);
  signInPolicyTestUser(userRoot, "writer", [repoId], "admin");
  registerBootstrappedDaemonRepo({ canonicalRoot: rootDir, repoId, userRoot, createConvenienceLinks: false });
  try {
    daemon = runningDaemon(
      await startDaemon({
        daemonId: repoId,
        userRoot,
        endpoint: localUserDaemonEndpoint(userRoot, repoId),
        openCell: async (input) => {
          attachmentStarted.resolve();
          await attachmentGate.promise;
          return openBootstrappedRepoCell(input);
        },
      }),
    );
    await attachmentStarted.promise;
    const status = await requestDaemonJsonRpcAt(daemon.endpoint, "daemon.status", {}, 2_000, 2_000);
    assert.equal((status.repos as { readonly state: string }[])[0]?.state, "warming");
    assert.match(String(status.summary), /attaching 0\/1/u);

    let writeSettled = false;
    const queuedWrite = requestDaemonJsonRpcAt(
      daemon.endpoint,
      "repo.task.create",
      { repo: { repoId }, payload: { taskId: "task-bind-first", title: "Bound before attach" } },
      2_000,
      5_000,
    ).then((receipt) => {
      writeSettled = true;
      return receipt;
    });
    await eventLoopTurn();
    assert.equal(writeSettled, false, "the accepted write waits behind attachment instead of losing its connection");
    attachmentReleased = true;
    attachmentGate.resolve();
    assert.equal((await queuedWrite).outcome, "applied");

    const events = readDaemonLifecycleRecords(userRoot, repoId).map((record) => record.event);
    assert.ok(events.indexOf("socket_bound") < events.indexOf("repo_attach_started"), JSON.stringify(events));
  } finally {
    if (!attachmentReleased) attachmentGate.resolve();
    await daemon?.stop();
    rmSync(parent, { recursive: true, force: true });
  }
});

test("a drifted daemon exits on its own while a runtime session is live", async () => {
  // A live runtime session is not work this daemon owns: the worker runs detached and the next
  // daemon re-adopts it by pid, so only queued writes and attaching repositories hold the exit.
  const parent = mkdtempSync(path.join(tmpdir(), "ha-daemon-live-build-drain-")),
    rootDir = path.join(parent, "repo"),
    userRoot = path.join(parent, "user"),
    runtimeRoot = path.join(parent, "runtime"),
    runtimeFile = builtRuntime(runtimeRoot, "build-a"),
    buildIdPath = path.join(runtimeRoot, "packages/cli/dist/build-id.txt"),
    repoId = "live-build-drain";
  const superseded = deferred<void>();
  let daemon: RunningDaemon | undefined;
  initializeRepo(rootDir, repoId);
  signInPolicyTestUser(userRoot, "writer", [repoId], "admin");
  registerBootstrappedDaemonRepo({ canonicalRoot: rootDir, repoId, userRoot, createConvenienceLinks: false });
  try {
    daemon = runningDaemon(
      await startDaemon({
        daemonId: repoId,
        userRoot,
        endpoint: localUserDaemonEndpoint(userRoot, repoId),
        runtimeFile,
        onSupersededExit: () => superseded.resolve(),
        openCell: async (input) => {
          const cell = await openBootstrappedRepoCell(input);
          input.recordLifecycle?.({
            event: "runtime_spawn",
            runtimeSessionId: "runtime-still-live",
            dispatchId: "dispatch-still-live",
            pid: process.pid,
          });
          input.recordLifecycle?.({
            event: "runtime_spawn",
            runtimeSessionId: "runtime-already-gone",
            dispatchId: "dispatch-already-gone",
            pid: 2_147_483_647,
          });
          return cell;
        },
      }),
    );
    await waitUntil(async () => {
      const status = await requestDaemonJsonRpcAt(daemon!.endpoint, "daemon.status", {}, 2_000, 2_000);
      return (status.repos as { readonly state: string }[])[0]?.state === "attached";
    });
    const originalPid = readDaemonPid(userRoot, repoId);
    writeFileSync(buildIdPath, "build-b\n", "utf8");
    const receipt = await requestDaemonJsonRpcAt(
      daemon.endpoint,
      "repo.task.create",
      { repo: { repoId }, payload: { taskId: "task-live-drain", title: "Served by old build" } },
      2_000,
      5_000,
      undefined,
      true,
    );
    assert.equal(receipt.outcome, "applied", JSON.stringify(receipt));
    const marker = receipt.daemonBuild as Record<string, unknown>;
    assert.deepEqual(
      {
        code: marker.code,
        loadedBuildId: marker.loadedBuildId,
        diskBuildId: marker.diskBuildId,
        liveRuntimeSessions: marker.liveRuntimeSessions,
      },
      { code: "daemon_build_stale", loadedBuildId: "build-a", diskBuildId: "build-b", liveRuntimeSessions: 1 },
    );
    await superseded.promise;
    assert.equal(readDaemonPid(userRoot, repoId), null);
    assert.equal(existsSync(daemon.endpoint), false);
    assert.notEqual(readDaemonPid(userRoot, repoId), originalPid);
    assert.equal(
      readDaemonLifecycleRecords(userRoot, repoId).some(
        (record) => record.event === "process_exit" && record.outcome === "build_superseded",
      ),
      true,
    );
  } finally {
    await daemon?.stop();
    rmSync(parent, { recursive: true, force: true });
  }
});

test("a drifted daemon stays resident while a write is queued behind an unfinished attachment", async () => {
  const parent = mkdtempSync(path.join(tmpdir(), "ha-daemon-drain-queued-write-")),
    rootDir = path.join(parent, "repo"),
    userRoot = path.join(parent, "user"),
    runtimeRoot = path.join(parent, "runtime"),
    runtimeFile = builtRuntime(runtimeRoot, "build-a"),
    buildIdPath = path.join(runtimeRoot, "packages/cli/dist/build-id.txt"),
    repoId = "drain-queued-write",
    attachmentGate = deferred<void>(),
    attachmentStarted = deferred<void>();
  const superseded = deferred<void>();
  let daemon: RunningDaemon | undefined,
    attachmentReleased = false;
  initializeRepo(rootDir, repoId);
  signInPolicyTestUser(userRoot, "writer", [repoId], "admin");
  registerBootstrappedDaemonRepo({ canonicalRoot: rootDir, repoId, userRoot, createConvenienceLinks: false });
  try {
    daemon = runningDaemon(
      await startDaemon({
        daemonId: repoId,
        userRoot,
        endpoint: localUserDaemonEndpoint(userRoot, repoId),
        runtimeFile,
        onSupersededExit: () => superseded.resolve(),
        openCell: async (input) => {
          attachmentStarted.resolve();
          await attachmentGate.promise;
          return openBootstrappedRepoCell(input);
        },
      }),
    );
    await attachmentStarted.promise;
    writeFileSync(buildIdPath, "build-b\n", "utf8");
    const queuedWrite = requestDaemonJsonRpcAt(
      daemon.endpoint,
      "repo.task.create",
      { repo: { repoId }, payload: { taskId: "task-drain-queued", title: "Queued behind attachment" } },
      2_000,
      5_000,
      undefined,
      true,
    );
    await eventLoopTurn();
    await eventLoopTurn();
    assert.equal(readDaemonPid(userRoot, repoId) !== null, true, "queued work keeps the drifted daemon resident");
    assert.equal(existsSync(daemon.endpoint), true);
    attachmentReleased = true;
    attachmentGate.resolve();
    assert.equal((await queuedWrite).outcome, "applied");
    await superseded.promise;
    assert.equal(readDaemonPid(userRoot, repoId), null);
    assert.equal(existsSync(daemon.endpoint), false);
    assert.equal(
      readDaemonLifecycleRecords(userRoot, repoId).some(
        (record) => record.event === "process_exit" && record.outcome === "build_superseded",
      ),
      true,
    );
  } finally {
    if (!attachmentReleased) attachmentGate.resolve();
    await daemon?.stop();
    rmSync(parent, { recursive: true, force: true });
  }
});

test("a drained superseded daemon exits and the next autostart loads the disk build", async () => {
  const parent = mkdtempSync(path.join(tmpdir(), "ha-daemon-superseded-exit-")),
    userRoot = path.join(parent, "user"),
    runtimeRoot = path.join(parent, "runtime"),
    runtimeFile = builtRuntime(runtimeRoot, "build-a"),
    buildIdPath = path.join(runtimeRoot, "packages/cli/dist/build-id.txt"),
    daemonId = "superseded-exit";
  const superseded = deferred<void>();
  let daemon: RunningDaemon | undefined,
    replacement: RunningDaemon | undefined,
    spawns = 0;
  try {
    daemon = runningDaemon(
      await startDaemon({
        daemonId,
        userRoot,
        runtimeFile,
        endpoint: localUserDaemonEndpoint(userRoot, daemonId),
        onSupersededExit: () => superseded.resolve(),
      }),
    );
    writeFileSync(buildIdPath, "build-b\n", "utf8");
    const staleStatus = await requestDaemonJsonRpcAt(
      daemon.endpoint,
      "daemon.status",
      {},
      2_000,
      2_000,
      undefined,
      true,
    );
    assert.equal((staleStatus.daemonBuild as Record<string, unknown>).liveRuntimeSessions, 0);
    await superseded.promise;
    assert.equal(readDaemonPid(userRoot, daemonId), null);
    assert.equal(existsSync(daemon.endpoint), false);
    assert.equal(
      readDaemonLifecycleRecords(userRoot, daemonId).some(
        (record) => record.event === "process_exit" && record.outcome === "build_superseded",
      ),
      true,
    );

    const started = await ensureLocalDaemonRunning({
      socketPath: daemon.endpoint,
      invokingRoot: process.cwd(),
      launch: () => launchSpec(userRoot, daemonId),
      spawnDetached: async () => {
        spawns += 1;
        replacement = runningDaemon(
          await startDaemon({
            daemonId,
            userRoot,
            runtimeFile,
            endpoint: localUserDaemonEndpoint(userRoot, daemonId),
            onSupersededExit: () => superseded.resolve(),
          }),
        );
      },
    });
    assert.equal(started.ok, true, JSON.stringify(started));
    assert.equal(spawns, 1);
    const current = await requestDaemonJsonRpcAt(daemon.endpoint, "daemon.status", {}, 2_000, 2_000);
    assert.deepEqual(current.build, {
      ...(current.build as Record<string, unknown>),
      loadedBuildId: "build-b",
      diskBuildId: "build-b",
      drifted: false,
    });
  } finally {
    await replacement?.stop();
    await daemon?.stop();
    rmSync(parent, { recursive: true, force: true });
  }
});

test("a superseded stop clears its deadline before waiting for successor readiness", async (context) => {
  const parent = mkdtempSync(path.join(tmpdir(), "ha-daemon-superseded-deadline-")),
    userRoot = path.join(parent, "user"),
    runtimeRoot = path.join(parent, "runtime"),
    runtimeFile = builtRuntime(runtimeRoot, "build-a"),
    buildIdPath = path.join(runtimeRoot, "packages/cli/dist/build-id.txt"),
    daemonId = "superseded-deadline",
    successorReady = deferred<void>(),
    handoffStarted = deferred<void>();
  let deadlineExceeded = false;
  let daemon: RunningDaemon | undefined;
  try {
    daemon = runningDaemon(
      await startDaemon({
        daemonId,
        userRoot,
        runtimeFile,
        endpoint: localUserDaemonEndpoint(userRoot, daemonId),
        shutdownDeadlineMs: 25,
        shutdownDeadlineExceeded: () => {
          deadlineExceeded = true;
        },
        onSupersededExit: async () => {
          handoffStarted.resolve();
          await successorReady.promise;
        },
      }),
    );
    // Freeze shutdown time while real teardown IO runs, however slowly the runner schedules it.
    context.mock.timers.enable({ apis: ["setTimeout"] });
    writeFileSync(buildIdPath, "build-b\n", "utf8");
    await requestDaemonJsonRpcAt(daemon.endpoint, "daemon.status", {}, 2_000, 2_000, undefined, true);
    await handoffStarted.promise;
    let stopSettled = false;
    const stopped = daemon.stop().then(() => {
      stopSettled = true;
    });
    // Cross the deadline while successor readiness remains blocked. An uncleared timer must fire.
    context.mock.timers.tick(250);
    await eventLoopTurn();
    assert.equal(deadlineExceeded, false, "successor readiness must not remain under the shutdown deadline");
    assert.equal(stopSettled, false, "the outgoing daemon must not finish before successor readiness");
    successorReady.resolve();
    await stopped;
  } finally {
    successorReady.resolve();
    await daemon?.stop();
    rmSync(parent, { recursive: true, force: true });
  }
});

test("a stop whose repository drain stalls still exceeds its shutdown deadline", async () => {
  const parent = mkdtempSync(path.join(tmpdir(), "ha-daemon-stalled-stop-deadline-")),
    rootDir = path.join(parent, "repo"),
    userRoot = path.join(parent, "user"),
    daemonId = "stalled-stop-deadline",
    attachmentStarted = deferred<void>(),
    attachmentGate = deferred<void>(),
    deadlineExceeded = deferred<void>();
  let daemon: RunningDaemon | undefined;
  initializeRepo(rootDir, daemonId);
  registerBootstrappedDaemonRepo({ canonicalRoot: rootDir, repoId: daemonId, userRoot, createConvenienceLinks: false });
  try {
    daemon = runningDaemon(
      await startDaemon({
        daemonId,
        userRoot,
        endpoint: localUserDaemonEndpoint(userRoot, daemonId),
        shutdownDeadlineMs: 25,
        shutdownDeadlineExceeded: () => deadlineExceeded.resolve(),
        openCell: async (input) => {
          attachmentStarted.resolve();
          await attachmentGate.promise;
          return openBootstrappedRepoCell(input);
        },
      }),
    );
    await attachmentStarted.promise;
    let stopSettled = false;
    const stopped = daemon.stop().then(() => {
      stopSettled = true;
    });
    await deadlineExceeded.promise;
    assert.equal(stopSettled, false, "the shutdown deadline must fire while repository drain is stalled");
    attachmentGate.resolve();
    await stopped;
  } finally {
    attachmentGate.resolve();
    await daemon?.stop();
    rmSync(parent, { recursive: true, force: true });
  }
});

test("an immediately exiting successor leaves the incumbent pid serving the unavailable disk build", async () => {
  const parent = mkdtempSync(path.join(tmpdir(), "ha-daemon-successor-exits-")),
    userRoot = path.join(parent, "user"),
    runtimeRoot = path.join(parent, "runtime"),
    runtimeFile = builtRuntime(runtimeRoot, "build-a"),
    buildIdPath = path.join(runtimeRoot, "packages/cli/dist/build-id.txt"),
    successor = path.join(parent, "successor.mjs"),
    daemonId = "successor-exits",
    endpoint = localUserDaemonEndpoint(userRoot, daemonId),
    buildObserver = observeDaemonBuild(runtimeFile),
    originalPid = process.pid;
  let daemon: RunningDaemon | undefined, recovered: RunningDaemon | undefined;
  writeFileSync(successor, "process.exit(23);\n", "utf8");
  try {
    daemon = runningDaemon(
      await startDaemon({
        daemonId,
        userRoot,
        runtimeFile,
        buildObserver,
        endpoint,
        onSupersededExit: async () => {
          const exited = spawn(process.execPath, [successor], { stdio: "ignore" });
          assert.equal(await new Promise<number | null>((resolve) => exited.once("close", resolve)), 23);
          recovered = runningDaemon(
            await startDaemon({
              daemonId,
              userRoot,
              runtimeFile,
              buildObserver,
              endpoint,
              buildSupersessionEnabled: false,
            }),
          );
        },
      }),
    );
    writeFileSync(buildIdPath, "build-b\n", "utf8");
    await requestDaemonJsonRpcAt(endpoint, "daemon.status", {}, 2_000, 2_000, undefined, true);
    await waitUntil(() => recovered !== undefined && readDaemonPid(userRoot, daemonId) === originalPid, 5_000);

    const status = await requestDaemonJsonRpcAt(endpoint, "daemon.status", {}, 2_000, 2_000, undefined, true);
    console.log(JSON.stringify({ recoveredDaemonStatus: status }));
    assert.equal(status.ok, true, JSON.stringify(status));
    assert.equal(status.pid, originalPid, JSON.stringify(status));
    assert.deepEqual(
      {
        code: (status.daemonBuild as Record<string, unknown>).code,
        loadedBuildId: (status.daemonBuild as Record<string, unknown>).loadedBuildId,
        diskBuildId: (status.daemonBuild as Record<string, unknown>).diskBuildId,
      },
      { code: "daemon_build_stale", loadedBuildId: "build-a", diskBuildId: "build-b" },
    );
  } finally {
    await recovered?.stop();
    await daemon?.stop();
    rmSync(parent, { recursive: true, force: true });
  }
});

test("a superseded exit restarts the disk build, which re-adopts the live runtime and settles its exit", async () => {
  const parent = mkdtempSync(path.join(tmpdir(), "ha-daemon-superseded-readopt-")),
    rootDir = path.join(parent, "repo"),
    userRoot = path.join(parent, "user"),
    runtimeRoot = path.join(parent, "runtime"),
    runtimeFile = builtRuntime(runtimeRoot, "build-a"),
    buildIdPath = path.join(runtimeRoot, "packages/cli/dist/build-id.txt"),
    repoId = "superseded-readopt",
    release = path.join(parent, "release"),
    providerPidFile = path.join(parent, "provider.pid"),
    endpoint = localUserDaemonEndpoint(userRoot, repoId),
    executablePath = writeProviderExecutable(
      path.join(parent, "readopt-provider.mjs"),
      `import fs from "node:fs";\nfs.readFileSync(0, "utf8");\nfs.writeFileSync(${JSON.stringify(providerPidFile)}, String(process.pid));\nconsole.log(JSON.stringify({ type: "thread.started", thread_id: "provider-readopt-session" }));\nconst timer = setInterval(() => { if (!fs.existsSync(${JSON.stringify(release)})) return; clearInterval(timer); console.log(JSON.stringify({ type: "item.completed", item: { id: "write", type: "file_change", changes: [{ path: "result.txt", kind: "add" }], status: "completed" } })); console.log(JSON.stringify({ type: "item.completed", item: { id: "message", type: "agent_message", text: "survived daemon supersession" } })); console.log(JSON.stringify({ type: "turn.completed", usage: { input_tokens: 1, output_tokens: 1 } })); }, 10);\n`,
    ),
    installation = {
      installationId: "installation-superseded-readopt",
      kindId: "codex" as const,
      executablePath,
      version: "1.0.0",
      observedAt: "2026-09-18T00:00:00.000Z",
    },
    definition: AgentDefinitionSnapshot = {
      schema: "agent-definition-snapshot/v1",
      configVersion: 1,
      instanceId: "codex-superseded-readopt",
      installationId: installation.installationId,
      kindId: "codex",
      providerId: "openai",
      model: "codex-model",
      reasoningEffort: null,
      baseUrl: null,
      authMode: "subscription",
    },
    instance = {
      schemaVersion: 2 as const,
      instanceId: definition.instanceId,
      name: "Codex Superseded Re-adopt",
      kindId: "codex" as const,
      installationId: installation.installationId,
      providerId: "openai",
      models: ["codex-model"],
      defaultModel: "codex-model",
      enabled: true,
      permissionMode: "workspace-write" as const,
      codex: {},
      authMode: "subscription" as const,
      authState: "configured" as const,
      authReadiness: { status: "ready" as const, code: null, hint: null },
      isolationState: "enforced" as const,
    },
    prepareRuntimeLaunch = async (_instanceId: string, request: { readonly cwd: string; readonly prompt: string }) => ({
      definition,
      installation,
      executablePath,
      args: ["exec", "--json", "--model", "codex-model", "-"],
      env: process.env,
      cwd: request.cwd,
      prompt: request.prompt,
    });
  let queuedStatusHeld = false,
    drainObserved = false,
    publishDrainedStatus: (() => void) | undefined;
  let daemon: RunningDaemon | undefined,
    replacement: RunningDaemon | undefined,
    successorStart: Promise<void> | undefined,
    spawnReceipt: Awaited<ReturnType<Awaited<ReturnType<typeof openBootstrappedRepoCell>>["spawnRuntime"]>> | undefined;
  const successorStarted = deferred<void>(),
    drainGate = deferred<void>(),
    drainStarted = deferred<void>(),
    cells: Awaited<ReturnType<typeof openBootstrappedRepoCell>>[] = [],
    openCell = async (input: Parameters<typeof openBootstrappedRepoCell>[0]) => {
      const cell = await openBootstrappedRepoCell({
        ...input,
        runtimeInstances: () => [instance],
        prepareRuntimeLaunch,
      });
      cells.push(cell);
      if (cells.length !== 1) return cell;
      const observed = Object.create(cell);
      // Hold the host-side writer status past the reply, as a delayed worker status message can.
      // Releasing it emits the existing status notification without another request or runtime exit.
      Object.defineProperty(observed, "status", {
        value: () => ({ ...cell.status(), ...(queuedStatusHeld ? { queueDepth: 1 } : {}) }),
      });
      publishDrainedStatus = () => input.onStatus?.(cell.status());
      Object.defineProperty(observed, "close", {
        value: async () => {
          drainObserved = true;
          drainStarted.resolve();
          await drainGate.promise;
          await cell.close();
        },
      });
      return observed;
    },
    repoAttached = async () => {
      try {
        const status = await requestDaemonJsonRpcAt(endpoint, "daemon.status", {}, 2_000, 2_000);
        return (status.repos as { readonly state: string }[])[0]?.state === "attached";
      } catch (error) {
        consumeKnownError(error);
        return false;
      }
    },
    readSession = (projectionName: string) => {
      const projection = makeTaskProjection({
        rootDir,
        projectionPath: path.join(parent, projectionName),
        eventStore: makeTaskEventReader({ repoId, rootDir }),
      });
      try {
        projection.catchUp();
        return projection.readRuntimeSession(String(spawnReceipt!.runtimeSessionId))!;
      } finally {
        projection.close();
      }
    };
  initializeRepo(rootDir, repoId);
  signInPolicyTestUser(userRoot, "writer", [repoId], "admin");
  registerBootstrappedDaemonRepo({ canonicalRoot: rootDir, repoId, userRoot, createConvenienceLinks: false });
  try {
    daemon = runningDaemon(
      await startDaemon({
        daemonId: repoId,
        userRoot,
        endpoint,
        runtimeFile,
        openCell,
        onSupersededExit: () => {
          successorStart = (async () => {
            replacement = runningDaemon(
              await startDaemon({ daemonId: repoId, userRoot, endpoint, runtimeFile, openCell }),
            );
          })();
          successorStarted.resolve();
        },
      }),
    );
    await waitUntil(repoAttached, 10_000);
    spawnReceipt = await cells[0]!.spawnRuntime(
      {
        runtimeInstanceId: instance.instanceId,
        cwd: { scope: "repo-root" },
        prompt: "Stay alive across the supersession exit",
        taskId: null,
        idempotencyKey: "superseded-readopt",
      },
      withPolicyGroup(
        { actor: { principal: { personId: "person-superseded-readopt" }, executor: null }, source: "local" },
        "admin",
      ),
    );
    assert.equal(spawnReceipt.outcome, "applied", JSON.stringify(spawnReceipt));
    const providerPid = await eventuallyValue(() => {
      try {
        const value = Number(readFileSync(providerPidFile, "utf8"));
        return Number.isInteger(value) && value > 0 ? value : null;
      } catch (error) {
        consumeKnownError(error);
        return null;
      }
    });
    queuedStatusHeld = true;
    writeFileSync(buildIdPath, "build-b\n", "utf8");
    const served = await requestDaemonJsonRpcAt(
      daemon.endpoint,
      "repo.task.create",
      { repo: { repoId }, payload: { taskId: "task-superseded-readopt", title: "Served by old build" } },
      2_000,
      5_000,
      undefined,
      true,
    );
    assert.equal(served.outcome, "applied", JSON.stringify(served));
    await eventLoopTurn();
    await eventLoopTurn();
    assert.equal(drainObserved, false, "the delayed queued status keeps supersession resident");
    queuedStatusHeld = false;
    publishDrainedStatus!();
    await waitUntil(() => drainObserved);
    await drainStarted.promise;
    assert.equal(successorStart, undefined, "the successor must not start before the repository drain completes");
    assert.equal(
      readDaemonLifecycleRecords(userRoot, repoId).some(
        (record) => record.event === "process_exit" && record.outcome === "build_superseded",
      ),
      false,
      "the old generation must not record its exit while the repository drain is held",
    );
    drainGate.resolve();
    // Exit is recorded after the repository drain, which has no three-second contract.
    // The callback witnesses the completed teardown; the daemon's shutdown deadline bounds it.
    await successorStarted.promise;
    assert.equal(
      readDaemonLifecycleRecords(userRoot, repoId).some(
        (record) => record.event === "process_exit" && record.outcome === "build_superseded",
      ),
      true,
      "the old generation must record its superseded exit before starting the successor",
    );
    await successorStart;
    await waitUntil(repoAttached, 10_000);
    const current = await requestDaemonJsonRpcAt(endpoint, "daemon.status", {}, 2_000, 2_000);
    assert.deepEqual(current.build, {
      ...(current.build as Record<string, unknown>),
      loadedBuildId: "build-b",
      diskBuildId: "build-b",
      drifted: false,
    });
    const records = readDaemonLifecycleRecords(userRoot, repoId),
      spawnsForSession = records.filter(
        (record) => record.event === "runtime_spawn" && record.runtimeSessionId === spawnReceipt.runtimeSessionId,
      );
    assert.equal(spawnsForSession.length, 2, "the successor generation must re-record the live session at adoption");
    const adopted = readSession("superseded-readopt-live.sqlite");
    assert.deepEqual({ liveness: adopted.liveness, outcome: adopted.outcome }, { liveness: "live", outcome: null });
    assert.doesNotThrow(() => process.kill(providerPid, 0), "the adopted runtime worker must still be alive");
    writeFileSync(release, "release");
    await waitUntil(
      () =>
        makeTaskEventReader({ repoId, rootDir })
          .read()
          .events.some(
            (event) =>
              event.type === "runtime_session_outcome_observed" &&
              event.payload.runtimeSessionId === spawnReceipt!.runtimeSessionId,
          ),
      10_000,
    );
    const settled = readSession("superseded-readopt-exited.sqlite");
    assert.deepEqual(
      { liveness: settled.liveness, outcome: settled.outcome, exitCode: settled.exitCode },
      { liveness: "exited", outcome: "succeeded", exitCode: 0 },
    );
    await waitUntil(() => {
      try {
        process.kill(providerPid, 0);
        return false;
      } catch (error) {
        consumeKnownError(error);
        return true;
      }
    });
  } finally {
    // A failed assertion can leave the successor mid-start: the drifted daemon's own teardown is
    // what calls onSupersededExit, so stop it first, settle the in-flight successor start, and only
    // then stop the successor — otherwise removing the user root underneath a starting daemon ends
    // the test with an unhandled ENOENT on the singleton lock.
    drainGate.resolve();
    await daemon?.stop();
    await successorStart?.catch((error: unknown) => consumeKnownError(error));
    await replacement?.stop();
    for (const cell of cells) await cell.close().catch((error: unknown) => consumeKnownError(error));
    rmSync(release, { force: true });
    rmSync(parent, { recursive: true, force: true });
  }
});

test("a superseded exit hands the slot over while a --wait client's parked await survives to the settled verdict", async () => {
  // The daemon-side await is a parked read: it holds no incomplete write, so it must not hold the
  // superseded daemon either. The same CLI wait client bridges the handoff and only returns once
  // the adopted runtime settles — the sentinel is not interrupted by the merge-time restart.
  const parent = mkdtempSync(path.join(tmpdir(), "ha-daemon-superseded-await-")),
    rootDir = path.join(parent, "repo"),
    userRoot = path.join(parent, "user"),
    runtimeRoot = path.join(parent, "runtime"),
    runtimeFile = builtRuntime(runtimeRoot, "build-a"),
    buildIdPath = path.join(runtimeRoot, "packages/cli/dist/build-id.txt"),
    repoId = "superseded-await",
    release = path.join(parent, "release"),
    providerPidFile = path.join(parent, "provider.pid"),
    endpoint = localUserDaemonEndpoint(userRoot, repoId),
    executablePath = writeProviderExecutable(
      path.join(parent, "await-provider.mjs"),
      `import fs from "node:fs";\nfs.readFileSync(0, "utf8");\nfs.writeFileSync(${JSON.stringify(providerPidFile)}, String(process.pid));\nconsole.log(JSON.stringify({ type: "thread.started", thread_id: "provider-await-session" }));\nconst timer = setInterval(() => { if (!fs.existsSync(${JSON.stringify(release)})) return; clearInterval(timer); console.log(JSON.stringify({ type: "item.completed", item: { id: "write", type: "file_change", changes: [{ path: "result.txt", kind: "add" }], status: "completed" } })); console.log(JSON.stringify({ type: "item.completed", item: { id: "message", type: "agent_message", text: "survived supersession with a parked wait" } })); console.log(JSON.stringify({ type: "turn.completed", usage: { input_tokens: 1, output_tokens: 1 } })); }, 10);\n`,
    ),
    installation = {
      installationId: "installation-superseded-await",
      kindId: "codex" as const,
      executablePath,
      version: "1.0.0",
      observedAt: "2026-09-19T00:00:00.000Z",
    },
    definition: AgentDefinitionSnapshot = {
      schema: "agent-definition-snapshot/v1",
      configVersion: 1,
      instanceId: "codex-superseded-await",
      installationId: installation.installationId,
      kindId: "codex",
      providerId: "openai",
      model: "codex-model",
      reasoningEffort: null,
      baseUrl: null,
      authMode: "subscription",
    },
    instance = {
      schemaVersion: 2 as const,
      instanceId: definition.instanceId,
      name: "Codex Superseded Await",
      kindId: "codex" as const,
      installationId: installation.installationId,
      providerId: "openai",
      models: ["codex-model"],
      defaultModel: "codex-model",
      enabled: true,
      permissionMode: "workspace-write" as const,
      codex: {},
      authMode: "subscription" as const,
      authState: "configured" as const,
      authReadiness: { status: "ready" as const, code: null, hint: null },
      isolationState: "enforced" as const,
    },
    prepareRuntimeLaunch = async (_instanceId: string, request: { readonly cwd: string; readonly prompt: string }) => ({
      definition,
      installation,
      executablePath,
      args: ["exec", "--json", "--model", "codex-model", "-"],
      env: process.env,
      cwd: request.cwd,
      prompt: request.prompt,
    });
  let daemon: RunningDaemon | undefined,
    replacement: RunningDaemon | undefined,
    successorStart: Promise<void> | undefined,
    spawnReceipt: Awaited<ReturnType<Awaited<ReturnType<typeof openBootstrappedRepoCell>>["spawnRuntime"]>> | undefined,
    waitClient:
      | { readonly result: (timeoutMs: number) => Promise<WaitClientResult>; readonly stop: () => void }
      | undefined;
  const successorStarted = deferred<void>(),
    cells: Awaited<ReturnType<typeof openBootstrappedRepoCell>>[] = [],
    // The parked wait is observed where it lands: every sessions.read the daemon serves, both the
    // CLI's probe and the await's own settle re-reads, cross this seam.
    sessionReads: string[] = [],
    openCell = async (input: Parameters<typeof openBootstrappedRepoCell>[0]) => {
      const cell = await openBootstrappedRepoCell({
        ...input,
        runtimeInstances: () => [instance],
        prepareRuntimeLaunch,
      });
      cells.push(cell);
      const observed = Object.create(cell);
      Object.defineProperty(observed, "read", {
        value: (
          method: string,
          payload?: Readonly<Record<string, unknown>>,
          binding?: Parameters<Awaited<ReturnType<typeof openBootstrappedRepoCell>>["read"]>[2],
        ) => {
          if (method === "repo.agentRuntime.sessions.read")
            sessionReads.push(String(payload?.runtimeSessionId ?? "unknown"));
          return cell.read(method as never, payload, binding);
        },
        enumerable: true,
      });
      return observed;
    },
    repoAttached = async () => {
      try {
        const status = await requestDaemonJsonRpcAt(endpoint, "daemon.status", {}, 2_000, 2_000);
        return (status.repos as { readonly state: string }[])[0]?.state === "attached";
      } catch (error) {
        consumeKnownError(error);
        return false;
      }
    };
  initializeRepo(rootDir, repoId);
  signInPolicyTestUser(userRoot, "writer", [repoId], "admin");
  registerBootstrappedDaemonRepo({ canonicalRoot: rootDir, repoId, userRoot, createConvenienceLinks: false });
  try {
    daemon = runningDaemon(
      await startDaemon({
        daemonId: repoId,
        userRoot,
        endpoint,
        runtimeFile,
        openCell,
        onSupersededExit: () => {
          successorStart = (async () => {
            replacement = runningDaemon(
              await startDaemon({ daemonId: repoId, userRoot, endpoint, runtimeFile, openCell }),
            );
          })();
          successorStarted.resolve();
        },
      }),
    );
    await waitUntil(repoAttached, 10_000);
    spawnReceipt = await cells[0]!.spawnRuntime(
      {
        runtimeInstanceId: instance.instanceId,
        cwd: { scope: "repo-root" },
        prompt: "Stay alive across the supersession exit with a parked wait",
        taskId: null,
        idempotencyKey: "superseded-await",
      },
      withPolicyGroup(
        { actor: { principal: { personId: "person-superseded-await" }, executor: null }, source: "local" },
        "admin",
      ),
    );
    assert.equal(spawnReceipt.outcome, "applied", JSON.stringify(spawnReceipt));
    const runtimeSessionId = String(spawnReceipt.runtimeSessionId),
      providerPid = await eventuallyValue(() => {
        try {
          const value = Number(readFileSync(providerPidFile, "utf8"));
          return Number.isInteger(value) && value > 0 ? value : null;
        } catch (error) {
          consumeKnownError(error);
          return null;
        }
      });
    assert.doesNotThrow(() => process.kill(providerPid, 0), "the runtime worker must be live while the wait parks");
    waitClient = spawnWaitClient({ rootDir, userRoot, repoId, runtimeSessionId });
    // Two sessions.reads — the CLI's probe and the await's first settle read — prove the daemon-side
    // await is parked before the drift is triggered.
    await waitUntil(() => sessionReads.filter((id) => id === runtimeSessionId).length >= 2, 10_000);
    writeFileSync(buildIdPath, "build-b\n", "utf8");
    const served = await requestDaemonJsonRpcAt(
      daemon.endpoint,
      "repo.task.create",
      { repo: { repoId }, payload: { taskId: "task-superseded-await", title: "Served by old build" } },
      2_000,
      5_000,
      undefined,
      true,
    );
    assert.equal(served.outcome, "applied", JSON.stringify(served));
    // Exit is recorded after the repository drain, which has no three-second contract.
    // The callback witnesses the completed teardown; the daemon's shutdown deadline bounds it.
    await successorStarted.promise;
    assert.equal(
      readDaemonLifecycleRecords(userRoot, repoId).some(
        (record) => record.event === "process_exit" && record.outcome === "build_superseded",
      ),
      true,
      "the old generation must record its superseded exit before starting the successor",
    );
    await successorStart;
    await waitUntil(repoAttached, 10_000);
    const current = await requestDaemonJsonRpcAt(endpoint, "daemon.status", {}, 2_000, 2_000);
    assert.deepEqual(current.build, {
      ...(current.build as Record<string, unknown>),
      loadedBuildId: "build-b",
      diskBuildId: "build-b",
      drifted: false,
    });
    writeFileSync(release, "release");
    const verdict = await waitClient.result(30_000);
    assert.equal(verdict.code, 0, `${verdict.stderr}\n${JSON.stringify(verdict.receipt)}`);
    assert.equal(verdict.receipt.outcome, "succeeded", JSON.stringify(verdict.receipt));
    assert.equal(verdict.receipt.exitCode, 0);
    assert.equal(verdict.receipt.runtimeSessionId, runtimeSessionId);
  } finally {
    waitClient?.stop();
    // Same settle-before-remove contract as the re-adopt test: a timed-out hand-off leaves the
    // successor mid-start when the fixture user root is about to disappear.
    await daemon?.stop();
    await successorStart?.catch((error: unknown) => consumeKnownError(error));
    await replacement?.stop();
    for (const cell of cells) await cell.close().catch((error: unknown) => consumeKnownError(error));
    rmSync(release, { force: true });
    rmSync(parent, { recursive: true, force: true });
  }
});

test("a parked --wait survives a drain that outlasts its settle re-read and still returns the settled verdict", async () => {
  // The drain closes RepoCells before the transport, so a parked await whose settle re-read wakes
  // inside that window reads a closed cell. Answering that repo_unavailable ended real sentinels
  // with an error while the runtime stayed live; the wake must stay silent and let the transport
  // teardown deliver the reconnect signal (incident: 2026-09-19 build-drift handoff).
  const parent = mkdtempSync(path.join(tmpdir(), "ha-daemon-drain-outlasts-await-")),
    rootDir = path.join(parent, "repo"),
    userRoot = path.join(parent, "user"),
    runtimeRoot = path.join(parent, "runtime"),
    runtimeFile = builtRuntime(runtimeRoot, "build-a"),
    buildIdPath = path.join(runtimeRoot, "packages/cli/dist/build-id.txt"),
    repoId = "drain-outlasts-await",
    release = path.join(parent, "release"),
    providerPidFile = path.join(parent, "provider.pid"),
    endpoint = localUserDaemonEndpoint(userRoot, repoId),
    executablePath = writeProviderExecutable(
      path.join(parent, "outlast-provider.mjs"),
      `import fs from "node:fs";\nfs.readFileSync(0, "utf8");\nfs.writeFileSync(${JSON.stringify(providerPidFile)}, String(process.pid));\nconsole.log(JSON.stringify({ type: "thread.started", thread_id: "provider-outlast-session" }));\nconst timer = setInterval(() => { if (!fs.existsSync(${JSON.stringify(release)})) return; clearInterval(timer); console.log(JSON.stringify({ type: "item.completed", item: { id: "write", type: "file_change", changes: [{ path: "result.txt", kind: "add" }], status: "completed" } })); console.log(JSON.stringify({ type: "item.completed", item: { id: "message", type: "agent_message", text: "survived a drain that outlasted the settle re-read" } })); console.log(JSON.stringify({ type: "turn.completed", usage: { input_tokens: 1, output_tokens: 1 } })); }, 10);\n`,
    ),
    installation = {
      installationId: "installation-drain-outlasts-await",
      kindId: "codex" as const,
      executablePath,
      version: "1.0.0",
      observedAt: "2026-09-19T00:00:00.000Z",
    },
    definition: AgentDefinitionSnapshot = {
      schema: "agent-definition-snapshot/v1",
      configVersion: 1,
      instanceId: "codex-drain-outlasts-await",
      installationId: installation.installationId,
      kindId: "codex",
      providerId: "openai",
      model: "codex-model",
      reasoningEffort: null,
      baseUrl: null,
      authMode: "subscription",
    },
    instance = {
      schemaVersion: 2 as const,
      instanceId: definition.instanceId,
      name: "Codex Drain Outlasts Await",
      kindId: "codex" as const,
      installationId: installation.installationId,
      providerId: "openai",
      models: ["codex-model"],
      defaultModel: "codex-model",
      enabled: true,
      permissionMode: "workspace-write" as const,
      codex: {},
      authMode: "subscription" as const,
      authState: "configured" as const,
      authReadiness: { status: "ready" as const, code: null, hint: null },
      isolationState: "enforced" as const,
    },
    prepareRuntimeLaunch = async (_instanceId: string, request: { readonly cwd: string; readonly prompt: string }) => ({
      definition,
      installation,
      executablePath,
      args: ["exec", "--json", "--model", "codex-model", "-"],
      env: process.env,
      cwd: request.cwd,
      prompt: request.prompt,
    });
  let daemon: RunningDaemon | undefined,
    replacement: RunningDaemon | undefined,
    successorStart: Promise<void> | undefined,
    spawnReceipt: Awaited<ReturnType<Awaited<ReturnType<typeof openBootstrappedRepoCell>>["spawnRuntime"]>> | undefined,
    waitClient:
      | {
          readonly closed: boolean;
          readonly result: (timeoutMs: number) => Promise<WaitClientResult>;
          readonly stop: () => void;
        }
      | undefined;
  // The incident's window is built here: the real cell close sets its closed flag at once (reads
  // through the cell fail from that moment) while host.close() is held open, so the transport the
  // wait client rides has not closed yet — exactly the ordering stop() guarantees.
  const successorStarted = deferred<void>(),
    drainGate = deferred<void>(),
    cellCloseStarted = deferred<void>(),
    cells: Awaited<ReturnType<typeof openBootstrappedRepoCell>>[] = [],
    sessionReads: string[] = [],
    openCell = async (input: Parameters<typeof openBootstrappedRepoCell>[0]) => {
      const cell = await openBootstrappedRepoCell({
        ...input,
        runtimeInstances: () => [instance],
        prepareRuntimeLaunch,
      });
      cells.push(cell);
      const observed = Object.create(cell);
      Object.defineProperty(observed, "read", {
        value: (
          method: string,
          payload?: Readonly<Record<string, unknown>>,
          binding?: Parameters<Awaited<ReturnType<typeof openBootstrappedRepoCell>>["read"]>[2],
        ) => {
          if (method === "repo.agentRuntime.sessions.read")
            sessionReads.push(String(payload?.runtimeSessionId ?? "unknown"));
          return cell.read(method as never, payload, binding);
        },
        enumerable: true,
      });
      let closing = false;
      Object.defineProperty(observed, "close", {
        value: async () => {
          if (closing) return;
          closing = true;
          const closingPromise = cell.close();
          cellCloseStarted.resolve();
          await drainGate.promise;
          await closingPromise;
        },
        enumerable: true,
      });
      return observed;
    },
    repoAttached = async () => {
      try {
        const status = await requestDaemonJsonRpcAt(endpoint, "daemon.status", {}, 2_000, 2_000);
        return (status.repos as { readonly state: string }[])[0]?.state === "attached";
      } catch (error) {
        consumeKnownError(error);
        return false;
      }
    };
  initializeRepo(rootDir, repoId);
  signInPolicyTestUser(userRoot, "writer", [repoId], "admin");
  registerBootstrappedDaemonRepo({ canonicalRoot: rootDir, repoId, userRoot, createConvenienceLinks: false });
  try {
    daemon = runningDaemon(
      await startDaemon({
        daemonId: repoId,
        userRoot,
        endpoint,
        runtimeFile,
        openCell,
        onSupersededExit: () => {
          successorStart = (async () => {
            replacement = runningDaemon(
              await startDaemon({ daemonId: repoId, userRoot, endpoint, runtimeFile, openCell }),
            );
          })();
          successorStarted.resolve();
        },
      }),
    );
    await waitUntil(repoAttached, 10_000);
    spawnReceipt = await cells[0]!.spawnRuntime(
      {
        runtimeInstanceId: instance.instanceId,
        cwd: { scope: "repo-root" },
        prompt: "Stay alive while the drain outlasts the parked wait's settle re-read",
        taskId: null,
        idempotencyKey: "drain-outlasts-await",
      },
      withPolicyGroup(
        { actor: { principal: { personId: "person-drain-outlasts-await" }, executor: null }, source: "local" },
        "admin",
      ),
    );
    assert.equal(spawnReceipt.outcome, "applied", JSON.stringify(spawnReceipt));
    const runtimeSessionId = String(spawnReceipt.runtimeSessionId),
      providerPid = await eventuallyValue(() => {
        try {
          const value = Number(readFileSync(providerPidFile, "utf8"));
          return Number.isInteger(value) && value > 0 ? value : null;
        } catch (error) {
          consumeKnownError(error);
          return null;
        }
      });
    assert.doesNotThrow(() => process.kill(providerPid, 0), "the runtime worker must be live while the wait parks");
    waitClient = spawnWaitClient({ rootDir, userRoot, repoId, runtimeSessionId });
    await waitUntil(() => sessionReads.filter((id) => id === runtimeSessionId).length >= 2, 10_000);
    writeFileSync(buildIdPath, "build-b\n", "utf8");
    const served = await requestDaemonJsonRpcAt(
      daemon.endpoint,
      "repo.task.create",
      { repo: { repoId }, payload: { taskId: "task-drain-outlasts", title: "Served by old build" } },
      2_000,
      5_000,
      undefined,
      true,
    );
    assert.equal(served.outcome, "applied", JSON.stringify(served));
    await waitUntil(
      () =>
        cellCloseStarted.promise.then(
          () => true,
          () => false,
        ),
      5_000,
    );
    // The parked await wakes on its settle grace timer and re-reads through the already-closed
    // cell while the transport is still up. That wake is the incident: it must not end the wait.
    const readsAtClose = sessionReads.length;
    await waitUntil(() => sessionReads.length > readsAtClose, 12_000);
    assert.equal(
      waitClient.closed,
      false,
      "the wait client must stay parked through the drain window instead of exiting on repo_unavailable",
    );
    drainGate.resolve();
    // Exit is recorded after the repository drain, which has no three-second contract.
    // The callback witnesses the completed teardown; the daemon's shutdown deadline bounds it.
    await successorStarted.promise;
    assert.equal(
      readDaemonLifecycleRecords(userRoot, repoId).some(
        (record) => record.event === "process_exit" && record.outcome === "build_superseded",
      ),
      true,
      "the old generation must record its superseded exit before starting the successor",
    );
    await successorStart;
    await waitUntil(repoAttached, 10_000);
    // By now any repo_unavailable answer from the drain-window wake has long since landed, so the
    // sentinel still being parked here is the deterministic half of the incident's assertion; the
    // settled verdict below is the other half.
    assert.equal(waitClient.closed, false, "the wait client must still be parked on the successor after the handoff");
    writeFileSync(release, "release");
    const verdict = await waitClient.result(30_000);
    assert.equal(verdict.code, 0, `${verdict.stderr}\n${JSON.stringify(verdict.receipt)}`);
    assert.equal(verdict.receipt.outcome, "succeeded", JSON.stringify(verdict.receipt));
    assert.equal(verdict.receipt.exitCode, 0);
    assert.equal(verdict.receipt.runtimeSessionId, runtimeSessionId);
  } finally {
    drainGate.resolve();
    waitClient?.stop();
    await daemon?.stop();
    await successorStart?.catch((error: unknown) => consumeKnownError(error));
    await replacement?.stop();
    for (const cell of cells) await cell.close().catch((error: unknown) => consumeKnownError(error));
    rmSync(release, { force: true });
    rmSync(parent, { recursive: true, force: true });
  }
});

test("autostart readiness is independent of a simulated 32 second canonical repository attachment", async (t) => {
  const simulatedCanonicalAttachMs = 32_000,
    parent = mkdtempSync(path.join(tmpdir(), "ha-daemon-autostart-attach-")),
    rootDir = path.join(parent, "repo"),
    userRoot = path.join(parent, "user"),
    repoId = "autostart-while-attaching",
    attachmentGate = deferred<void>(),
    attachmentStarted = deferred<void>();
  let daemon: RunningDaemon | undefined,
    daemonStart: Promise<RunningDaemon> | undefined,
    attachmentCompleted = false;
  t.after(() => rmSync(parent, { recursive: true, force: true }));
  initializeRepo(rootDir, repoId);
  signInPolicyTestUser(userRoot, "writer", [repoId], "admin");
  registerBootstrappedDaemonRepo({ canonicalRoot: rootDir, repoId, userRoot, createConvenienceLinks: false });
  try {
    const endpoint = localUserDaemonEndpoint(userRoot, repoId),
      started = await ensureLocalDaemonRunning({
        socketPath: endpoint,
        invokingRoot: rootDir,
        launch: () => launchSpec(userRoot, repoId),
        spawnDetached: async () => {
          daemonStart = startDaemon({
            daemonId: repoId,
            userRoot,
            endpoint,
            openCell: async (input) => {
              attachmentStarted.resolve();
              await attachmentGate.promise;
              attachmentCompleted = true;
              return openBootstrappedRepoCell(input);
            },
          }).then((startedDaemon) => {
            daemon = runningDaemon(startedDaemon);
            return daemon;
          });
          await attachmentStarted.promise;
        },
      });
    assert.equal(started.ok, true, JSON.stringify({ started, simulatedCanonicalAttachMs }));
    await attachmentStarted.promise;
    assert.equal(attachmentCompleted, false, "socket readiness must not await the controlled attachment gate");
    const status = await requestDaemonJsonRpcAt(endpoint, "daemon.status", {}, 2_000, 2_000);
    assert.match(String(status.summary), /attaching 0\/1/u);
  } finally {
    attachmentGate.resolve();
    if (!daemon && daemonStart) daemon = await daemonStart;
    await daemon?.stop();
  }
});

test("a drain that rejects still releases the pid file and the singleton lock", async () => {
  // The stop sequence used to release the pid file and the lock after the awaits, so any rejection on
  // the way down left both behind and the next daemon could never claim the singleton. A long
  // migration replay failing inside RepoCell.close is the path that surfaced this on main.
  const parent = mkdtempSync(path.join(tmpdir(), "ha-daemon-stop-drain-reject-")),
    rootDir = path.join(parent, "repo"),
    userRoot = path.join(parent, "user"),
    repoId = "stop-drain-reject",
    lockPath = daemonSingletonLockPath(userRoot, repoId);
  let daemon: RunningDaemon | undefined,
    // The injected close never reaches the real cell, so the test owns closing it: otherwise its
    // worker thread keeps the test process alive after every assertion has passed.
    realCell: Awaited<ReturnType<typeof openBootstrappedRepoCell>> | undefined;
  initializeRepo(rootDir, repoId);
  signInPolicyTestUser(userRoot, "writer", [repoId], "admin");
  registerBootstrappedDaemonRepo({ canonicalRoot: rootDir, repoId, userRoot, createConvenienceLinks: false });
  try {
    daemon = runningDaemon(
      await startDaemon({
        daemonId: repoId,
        userRoot,
        endpoint: localUserDaemonEndpoint(userRoot, repoId),
        openCell: async (input) => {
          const cell = await openBootstrappedRepoCell(input);
          realCell = cell;
          return {
            ...cell,
            close: async () => {
              throw new Error("simulated migration replay failure during close");
            },
          };
        },
      }),
    );
    assert.equal(existsSync(lockPath), true, "the running daemon holds the singleton lock");
    // Attachment is async: stopping before the cell lands would close an empty registry and never
    // reach the injected failure, which is the same trap that makes this bug hard to see.
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const status = await requestDaemonJsonRpcAt(daemon.endpoint, "daemon.status", {}, 2_000, 2_000);
      if ((status.repos as { readonly state: string }[])[0]?.state === "attached") break;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }

    await assert.rejects(daemon.stop(), /simulated migration replay failure during close/u);

    assert.equal(existsSync(lockPath), false, "stop exit must release the singleton lock");
    assert.equal(readDaemonPid(userRoot, repoId), null, "stop exit must remove the pid file");
    assert.equal(existsSync(localUserDaemonEndpoint(userRoot, repoId)), false, "stop exit must remove the socket");
    daemon = undefined;
  } finally {
    await daemon?.stop().catch(() => undefined);
    await realCell?.close().catch(() => undefined);
    rmSync(parent, { recursive: true, force: true });
  }
});

test("a pid file that cannot be removed still releases the singleton lock", async () => {
  // Pid removal sits between the socket teardown and the lock release. If it throws, the lock must
  // still go: a held lock with no live daemon behind it is exactly the state stop exists to prevent.
  const parent = mkdtempSync(path.join(tmpdir(), "ha-daemon-stop-pid-stuck-")),
    rootDir = path.join(parent, "repo"),
    userRoot = path.join(parent, "user"),
    repoId = "stop-pid-stuck",
    lockPath = daemonSingletonLockPath(userRoot, repoId),
    pidPath = daemonPidPath(userRoot, repoId);
  let daemon: RunningDaemon | undefined;
  initializeRepo(rootDir, repoId);
  signInPolicyTestUser(userRoot, "writer", [repoId], "admin");
  registerBootstrappedDaemonRepo({ canonicalRoot: rootDir, repoId, userRoot, createConvenienceLinks: false });
  try {
    daemon = runningDaemon(
      await startDaemon({ daemonId: repoId, userRoot, endpoint: localUserDaemonEndpoint(userRoot, repoId) }),
    );
    assert.equal(existsSync(lockPath), true, "the running daemon holds the singleton lock");
    // A non-empty directory in the pid file's place makes the non-recursive rmSync throw.
    rmSync(pidPath, { force: true });
    mkdirSync(path.join(pidPath, "stuck"), { recursive: true });

    await daemon.stop();

    assert.equal(existsSync(lockPath), false, "stop exit must release the singleton lock");
    assert.equal(existsSync(localUserDaemonEndpoint(userRoot, repoId)), false, "stop exit must remove the socket");
    daemon = undefined;
  } finally {
    await daemon?.stop().catch(() => undefined);
    rmSync(parent, { recursive: true, force: true });
  }
});

function runningDaemon(started: Awaited<ReturnType<typeof startDaemon>>): RunningDaemon {
  if (!("stop" in started)) throw new Error(`daemon start deferred unexpectedly: ${JSON.stringify(started)}`);
  return started;
}

interface WaitClientResult {
  readonly code: number | null;
  readonly receipt: Record<string, unknown>;
  readonly stderr: string;
}

/** One real `runtime status <id> --wait` client against the fixture daemon: a child CLI process is
 *  the only caller that exercises the wait's own reconnect-and-reissue behavior across the handoff. */
function spawnWaitClient(input: {
  readonly rootDir: string;
  readonly userRoot: string;
  readonly repoId: string;
  readonly runtimeSessionId: string;
}): {
  readonly closed: boolean;
  readonly result: (timeoutMs: number) => Promise<WaitClientResult>;
  readonly stop: () => void;
} {
  const cli = path.resolve("packages/cli/src/index.ts"),
    {
      HARNESS_ACTOR: _actor,
      HARNESS_DAEMON_ENDPOINT: _endpoint,
      HARNESS_DAEMON_RELAY: _relay,
      ...baseEnv
    } = process.env,
    child: ChildProcess = spawn(
      process.execPath,
      [cli, "--root", input.rootDir, "--json", "runtime", "status", input.runtimeSessionId, "--wait", "--no-stream"],
      {
        env: {
          ...baseEnv,
          HARNESS_DAEMON_USER_ROOT: input.userRoot,
          HARNESS_DAEMON_ID: input.repoId,
          HARNESS_DAEMON_REPO_ID: input.repoId,
        },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
  let stdout = "",
    stderr = "",
    exited = false;
  child.stdout!.on("data", (chunk) => (stdout += String(chunk)));
  child.stderr!.on("data", (chunk) => (stderr += String(chunk)));
  const completion = new Promise<WaitClientResult>((resolve) => {
    child.once("close", (code) => {
      exited = true;
      resolve({
        code,
        receipt: stdout.trim() ? (JSON.parse(stdout) as Record<string, unknown>) : {},
        stderr,
      });
    });
  });
  return {
    get closed() {
      return exited;
    },
    result: async (timeoutMs) => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        return await Promise.race([
          completion,
          new Promise<never>((_resolve, reject) => {
            timer = setTimeout(() => {
              child.kill("SIGKILL");
              reject(new Error(`runtime status --wait did not return within ${String(timeoutMs)}ms`));
            }, timeoutMs);
          }),
        ]);
      } finally {
        clearTimeout(timer);
      }
    },
    stop: () => {
      child.kill("SIGKILL");
    },
  };
}

function launchSpec(userRoot: string, daemonId: string): DaemonLaunchSpec {
  return {
    command: process.execPath,
    args: ["index.js", "serve", "--user-root", userRoot, "--daemon-id", daemonId],
    env: {},
  };
}

function builtRuntime(runtimeRoot: string, buildId: string): string {
  const runtimeFile = path.join(runtimeRoot, "packages/cli/dist/daemon/src/runtime.js"),
    marker = path.join(runtimeRoot, "packages/cli/dist/build-id.txt");
  for (const [file, body] of [
    [runtimeFile, "runtime\n"],
    [marker, `${buildId}\n`],
  ] as const) {
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, body, "utf8");
  }
  return runtimeFile;
}

function initializeRepo(rootDir: string, repoId: string): void {
  mkdirSync(rootDir, { recursive: true });
  git(rootDir, "init", "--quiet");
  git(rootDir, "config", "user.name", "Daemon Build Drain Test");
  git(rootDir, "config", "user.email", "daemon-build-drain@example.invalid");
  git(rootDir, "config", "gc.auto", "0");
  git(rootDir, "commit", "--allow-empty", "--quiet", "-m", "fixture base");
  mkdirSync(path.join(rootDir, "harness"));
  writeFileSync(
    path.join(rootDir, "harness/harness.yaml"),
    `schema: harness-anything/v1\nname: ${repoId}\nlayout:\n  authoredRoot: harness\n  localRoot: .harness\n`,
  );

  git(rootDir, "add", "harness");
  git(rootDir, "commit", "--quiet", "-m", "add repository fixture");
}

function git(rootDir: string, ...args: readonly string[]): string {
  return execFileSync("git", ["-C", rootDir, ...args], { encoding: "utf8" }).trim();
}

function deferred<T>(): { readonly promise: Promise<T>; readonly resolve: (value?: T) => void } {
  let resolvePromise!: (value: T) => void;
  const promise = new Promise<T>((resolve) => {
    resolvePromise = resolve;
  });
  return { promise, resolve: (value?: T) => resolvePromise(value as T) };
}

async function waitUntil(predicate: () => boolean | Promise<boolean>, timeoutMs = 3_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.fail(`condition did not settle within ${String(timeoutMs)}ms`);
}

async function eventuallyValue<T>(read: () => T | null, timeoutMs = 10_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = read();
    if (value !== null) return value;
    if (Date.now() >= deadline) assert.fail(`condition did not settle within ${String(timeoutMs)}ms`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

function eventLoopTurn(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}
